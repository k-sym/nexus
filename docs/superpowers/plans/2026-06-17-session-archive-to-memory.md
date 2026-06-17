# Session Archive to Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session archive action that summarizes a project chat into memory using the local model, then deletes the session.

**Architecture:** Put the archive workflow in a focused backend service under `src/backend/sessions/archive.ts`, with injected summarizer and memory-store functions so tests do not need a live model or memory daemon. Keep the HTTP route thin, reuse existing thread delete cleanup, and wire a new archive action into the sidebar next to rename/delete.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, pi runtime session reader, OpenAI-compatible local `/chat/completions`, React, Vitest, node:test.

---

## File Structure

- Create `src/backend/sessions/archive.ts`: archive orchestration, transcript extraction, local model completion, and typed archive errors.
- Modify `src/backend/routes/chat.ts`: replace the current soft-archive endpoint with the archive service and keep hard delete as throw-away deletion.
- Modify `src/backend/test/routes-chat.test.ts`: add backend archive coverage using `archiveThreadToMemory` with injected summarizer and memory-store dependencies.
- Modify `src/frontend/src/api.ts`: expose `api.chat.archiveThread(threadId)`.
- Modify `src/frontend/src/App.tsx`: add `handleArchiveThread`, clear the active thread on success, and refresh sessions.
- Modify `src/frontend/src/components/Sidebar.tsx`: add archive icon and `onArchiveThread` prop.
- Modify `src/frontend/src/components/Sidebar.test.tsx`: test archive action and delete/archive separation.

---

### Task 1: Backend Archive Service

**Files:**
- Create: `src/backend/sessions/archive.ts`
- Test: `src/backend/test/routes-chat.test.ts`

- [ ] **Step 1: Add failing service tests**

Append these tests to `src/backend/test/routes-chat.test.ts`. They exercise the service directly so model and memory behavior can be injected without a daemon.

```ts
test('archiveThreadToMemory summarizes, stores memory, deletes the thread, and drops pi session files', async () => {
  const stored: any[] = [];
  const dropped: Array<{ threadId: string; cwd: string }> = [];
  const { archiveThreadToMemory } = await import('../sessions/archive');
  const { app, db, dir } = makeApp({
    readMessages: async () => [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'We need archive sessions.' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Decision: archive writes memory before deleting.' }] } },
    ],
    dropSession: (threadId: string, cwd: string) => dropped.push({ threadId, cwd }),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    models: { find: () => undefined },
  });
  try {
    const result = await archiveThreadToMemory(db, app.pi, 'thread-1', {
      summarize: async (input) => {
        assert.match(input.transcript, /archive sessions/);
        return 'Archive sessions should preserve decisions in memory before deleting the source chat.';
      },
      storeMemory: async (input) => {
        stored.push(input);
        return { id: 'memory-1' };
      },
    });

    assert.equal(result.memoryId, 'memory-1');
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 0);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].category, 'session_archive');
    assert.equal(stored[0].agent_id, 'session-archive');
    assert.equal(stored[0].metadata.thread_id, 'thread-1');
    assert.deepEqual(dropped, [{ threadId: 'thread-1', cwd: dir }]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveThreadToMemory keeps the thread when memory storage fails', async () => {
  const { archiveThreadToMemory, ArchiveThreadError } = await import('../sessions/archive');
  const { app, db, dir } = makeApp({
    readMessages: async () => [
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Decision: keep source when memory fails.' }] } },
    ],
    dropSession: () => assert.fail('dropSession must not run when memory fails'),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    models: { find: () => undefined },
  });
  try {
    await assert.rejects(
      archiveThreadToMemory(db, app.pi, 'thread-1', {
        summarize: async () => 'A usable summary',
        storeMemory: async () => null,
      }),
      (err: unknown) => err instanceof ArchiveThreadError && err.statusCode === 502 && /memory/i.test(err.message),
    );
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 1);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveThreadToMemory rejects empty sessions without deleting', async () => {
  const { archiveThreadToMemory, ArchiveThreadError } = await import('../sessions/archive');
  const { app, db, dir } = makeApp({
    readMessages: async () => [],
    dropSession: () => assert.fail('dropSession must not run for empty sessions'),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    models: { find: () => undefined },
  });
  try {
    await assert.rejects(
      archiveThreadToMemory(db, app.pi, 'thread-1', {
        summarize: async () => assert.fail('summarize must not run for empty sessions'),
        storeMemory: async () => assert.fail('storeMemory must not run for empty sessions'),
      }),
      (err: unknown) => err instanceof ArchiveThreadError && err.statusCode === 400 && /no meaningful/i.test(err.message),
    );
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 1);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run backend tests to verify failure**

Run: `npm test --workspace=src/backend -- --test-name-pattern archiveThreadToMemory`

Expected: FAIL with `Cannot find module '../sessions/archive'`.

- [ ] **Step 3: Implement the archive service**

Create `src/backend/sessions/archive.ts` with:

```ts
import type Database from 'better-sqlite3';
import type { ChatThread, Project } from '@nexus/shared';
import type { PiRuntime } from '../pi/runtime.js';
import { loadConfig, resolveEnvVars } from '../config.js';
import { addMemory, type MemoryInput } from '../memory/index.js';

export class ArchiveThreadError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ArchiveThreadError';
  }
}

interface TranscriptMessage {
  role: string;
  text: string;
}

interface ArchiveDeps {
  summarize?: (input: { thread: ChatThread; project: Project; transcript: string }) => Promise<string>;
  storeMemory?: (input: MemoryInput) => Promise<{ id: string } | null>;
}

export async function archiveThreadToMemory(
  db: Database.Database,
  pi: Pick<PiRuntime, 'readMessages' | 'dropSession'>,
  threadId: string,
  deps: ArchiveDeps = {},
): Promise<{ memoryId: string | null }> {
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
  if (!thread) throw new ArchiveThreadError(404, 'Thread not found');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(thread.project_id) as Project | undefined;
  if (!project) throw new ArchiveThreadError(404, 'Project not found');

  const transcript = await loadTranscript(db, pi, thread.id, project.repo_path);
  if (!hasMeaningfulTranscript(transcript)) {
    throw new ArchiveThreadError(400, 'Session has no meaningful chat history to archive');
  }

  const summarize = deps.summarize ?? summarizeWithLocalModel;
  const summary = (await summarize({ thread, project, transcript })).trim();
  if (!summary) throw new ArchiveThreadError(502, 'Local model returned an empty archive summary');

  const storeMemory = deps.storeMemory ?? ((input: MemoryInput) => addMemory(db, input));
  const stored = await storeMemory({
    project_id: project.id,
    agent_id: 'session-archive',
    category: 'session_archive',
    content: summary,
    metadata: {
      source: 'session-archive',
      thread_id: thread.id,
      thread_title: thread.title,
    },
  });
  if (!stored) throw new ArchiveThreadError(502, 'Failed to write archive summary to memory');

  db.prepare('DELETE FROM chat_threads WHERE id = ?').run(thread.id);
  pi.dropSession(thread.id, project.repo_path);
  return { memoryId: stored.id };
}

async function loadTranscript(
  db: Database.Database,
  pi: Pick<PiRuntime, 'readMessages'>,
  threadId: string,
  cwd: string,
): Promise<string> {
  let messages: TranscriptMessage[] = [];
  try {
    messages = entriesToTranscriptMessages(await pi.readMessages(threadId, cwd));
  } catch (err: any) {
    console.error(`[archive] failed to read pi session ${threadId}:`, err?.message);
  }
  if (messages.length === 0) messages = dbTranscriptMessages(db, threadId);
  return messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join('\n\n').slice(0, 30000);
}

function entriesToTranscriptMessages(entries: unknown[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of entries as Array<{ message?: { role?: string; content?: unknown } }>) {
    const message = entry.message;
    if (!message?.role) continue;
    const text = contentToText(message.content).trim();
    if (text) messages.push({ role: message.role, text });
  }
  return messages;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function dbTranscriptMessages(db: Database.Database, threadId: string): TranscriptMessage[] {
  try {
    return db
      .prepare("SELECT role, content FROM chat_messages WHERE thread_id = ? AND content <> '' ORDER BY created_at ASC")
      .all(threadId)
      .map((row: any) => ({ role: row.role, text: row.content }));
  } catch {
    return [];
  }
}

function hasMeaningfulTranscript(transcript: string): boolean {
  return transcript.replace(/\s+/g, ' ').trim().length >= 20;
}

export async function summarizeWithLocalModel(input: {
  thread: ChatThread;
  project: Project;
  transcript: string;
}): Promise<string> {
  const config = loadConfig();
  const baseUrl = config.models.local.base_url.replace(/\/+$/, '');
  const apiKey = resolveEnvVars(config.models.local.api_key || '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'Summarize this Nexus session for long-term project memory. Keep only durable decisions, constraints, implementation notes, discoveries, user preferences, and follow-up context. Exclude chat filler and transient status.',
        },
        {
          role: 'user',
          content: `Project: ${input.project.name}\nSession: ${input.thread.title}\n\nTranscript:\n${input.transcript}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new ArchiveThreadError(502, `Local model archive summary failed (${res.status}${body ? `: ${body}` : ''})`);
  }
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '').trim();
}
```

- [ ] **Step 4: Run service tests**

Run: `npm test --workspace=src/backend -- --test-name-pattern archiveThreadToMemory`

Expected: PASS for all three archive service tests.

- [ ] **Step 5: Commit backend service**

```bash
git add src/backend/sessions/archive.ts src/backend/test/routes-chat.test.ts
git commit -m "feat: add session archive service"
```

---

### Task 2: Archive HTTP Route

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Test: `src/backend/test/routes-chat.test.ts`

- [ ] **Step 1: Add failing route tests**

Append these tests to `src/backend/test/routes-chat.test.ts`. They verify the route contract and that delete remains a separate throw-away path.

```ts
test('DELETE /api/threads/:id removes the thread without calling archive storage', async () => {
  const runtime = {
    readMessages: async () => assert.fail('delete must not read messages for archive'),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/archive returns an error and keeps empty sessions', async () => {
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => assert.fail('archive must not drop empty sessions'),
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/threads/thread-1/archive' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /no meaningful/i);
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 1);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run: `npm test --workspace=src/backend -- --test-name-pattern "DELETE /api/threads|POST /api/threads/:id/archive"`

Expected: The empty archive route test fails because the current route returns success after setting `archived_at`.

- [ ] **Step 3: Wire the route to the archive service**

Modify `src/backend/routes/chat.ts`:

```ts
import { archiveThreadToMemory, ArchiveThreadError } from '../sessions/archive.js';
```

Replace the current `fastify.post('/api/threads/:threadId/archive'...)` body with:

```ts
  fastify.post('/api/threads/:threadId/archive', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    try {
      return await archiveThreadToMemory(db, pi, threadId);
    } catch (err: any) {
      if (err instanceof ArchiveThreadError) {
        reply.code(err.statusCode);
        return { error: err.message };
      }
      console.error(`[archive] failed to archive thread ${threadId}:`, err?.message);
      reply.code(500);
      return { error: 'Failed to archive session' };
    }
  });
```

- [ ] **Step 4: Run backend route tests**

Run: `npm test --workspace=src/backend -- --test-name-pattern "archive|DELETE /api/threads"`

Expected: PASS for archive service tests and route separation tests.

- [ ] **Step 5: Commit route wiring**

```bash
git add src/backend/routes/chat.ts src/backend/test/routes-chat.test.ts
git commit -m "feat: archive sessions through backend route"
```

---

### Task 3: Frontend API and App Handler

**Files:**
- Modify: `src/frontend/src/api.ts`
- Modify: `src/frontend/src/App.tsx`
- Test: `src/frontend/src/components/Sidebar.test.tsx`

- [ ] **Step 1: Update the API client**

Modify the `chat` API object in `src/frontend/src/api.ts` so it exposes both archive and delete:

```ts
    archiveThread: (threadId: string) => fetchJson<{ memoryId: string | null }>(`/api/threads/${threadId}/archive`, { method: 'POST' }),
    deleteThread: (threadId: string) => fetchJson<void>(`/api/threads/${threadId}`, { method: 'DELETE' }),
```

- [ ] **Step 2: Add App archive handler**

In `src/frontend/src/App.tsx`, add this function beside `handleDeleteThread`:

```tsx
  const handleArchiveThread = async (threadId: string) => {
    await api.chat.archiveThread(threadId);
    if (threadId === activeThreadId) setActiveThreadId(null);
    if (activeProjectId) await loadThreads(activeProjectId);
  };
```

Pass it to `Sidebar`:

```tsx
          onArchiveThread={handleArchiveThread}
```

- [ ] **Step 3: Run frontend typecheck to reveal missing prop wiring**

Run: `npm run --workspace=src/frontend typecheck`

Expected: FAIL with a TypeScript error that `Sidebar` does not accept `onArchiveThread`.

- [ ] **Step 4: Commit API and App wiring after Sidebar prop exists in Task 4**

Do not commit during this task until Task 4 adds the prop and typecheck passes.

---

### Task 4: Sidebar Archive Action

**Files:**
- Modify: `src/frontend/src/components/Sidebar.tsx`
- Test: `src/frontend/src/components/Sidebar.test.tsx`

- [ ] **Step 1: Add failing sidebar tests**

Update `renderSidebar` in `src/frontend/src/components/Sidebar.test.tsx` to accept `onArchiveThread` and pass it to `Sidebar`:

```tsx
  onArchiveThread = noop,
}: {
  threads?: ThreadMeta[];
  activeSessionIds?: Set<string>;
  onEditProject?: (project: Project) => void;
  onDeleteProject?: (projectId: string) => void;
  onReorderProjects?: (projectIds: string[]) => void;
  onArchiveThread?: (threadId: string) => void;
} = {}) {
```

```tsx
      onArchiveThread={onArchiveThread}
```

Add these tests:

```tsx
  it('offers an archive action for sessions', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSidebar({ onArchiveThread });

    await user.click(screen.getByTitle('Archive to memory'));

    expect(window.confirm).toHaveBeenCalledWith('Archive this session to memory and delete it?');
    expect(onArchiveThread).toHaveBeenCalledWith(thread.id);
  });

  it('keeps delete separate from archive', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    const onDeleteThread = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <Sidebar
        projects={[project, secondProject]}
        activeProjectId={project.id}
        subView="chat"
        activeThreadId={thread.id}
        threads={[{ thread }]}
        activeSessionIds={new Set()}
        projectCounts={{ [project.id]: { tasks: 3, sessions: 1 }, [secondProject.id]: { tasks: 10, sessions: 2 } }}
        onSelectProject={noop}
        onSelectSubView={noop}
        onSelectThread={noop}
        onRenameThread={noop}
        onArchiveThread={onArchiveThread}
        onDeleteThread={onDeleteThread}
        onNewChat={noop}
        onNewProject={noop}
        onEditProject={noop}
        onDeleteProject={noop}
        onReorderProjects={noop}
      />,
    );

    await user.click(screen.getByTitle('Delete'));

    expect(onDeleteThread).toHaveBeenCalledWith(thread.id);
    expect(onArchiveThread).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run sidebar tests to verify failure**

Run: `npm test --workspace=src/frontend -- Sidebar.test.tsx`

Expected: FAIL because the archive action is not rendered and the prop is missing.

- [ ] **Step 3: Implement Sidebar prop and icon**

Modify `src/frontend/src/components/Sidebar.tsx`:

```tsx
import { CaretRight, CaretDown, Kanban, Brain, ChatCircle, Plus, PencilSimple, Trash, ArchiveBox } from '@phosphor-icons/react';
```

Add the prop:

```ts
  onArchiveThread: (threadId: string) => void;
```

Destructure it:

```tsx
  onSelectProject, onSelectSubView, onSelectThread, onRenameThread, onArchiveThread, onDeleteThread, onNewChat, onNewProject,
```

Add the archive action before delete in the session hover actions:

```tsx
                                  <span
                                    role="button"
                                    title="Archive to memory"
                                    className="text-faint hover:text-[var(--text-primary)]"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      if (window.confirm('Archive this session to memory and delete it?')) onArchiveThread(thread.id);
                                    }}
                                  >
                                    <ArchiveBox size={13} />
                                  </span>
```

- [ ] **Step 4: Run frontend tests and typecheck**

Run: `npm test --workspace=src/frontend -- Sidebar.test.tsx`

Expected: PASS for Sidebar tests.

Run: `npm run --workspace=src/frontend typecheck`

Expected: PASS.

- [ ] **Step 5: Commit frontend archive action**

```bash
git add src/frontend/src/api.ts src/frontend/src/App.tsx src/frontend/src/components/Sidebar.tsx src/frontend/src/components/Sidebar.test.tsx
git commit -m "feat: add session archive action"
```

---

### Task 5: Full Verification

**Files:**
- Verify: backend, frontend, shared types

- [ ] **Step 1: Run backend tests**

Run: `npm test --workspace=src/backend`

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run: `npm test --workspace=src/frontend`

Expected: PASS.

- [ ] **Step 3: Run full typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run full build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run: `git status --short`

Expected: only intentional files are modified if any verification command updated artifacts.

Run: `git log --oneline -5`

Expected: includes the implementation commits from Tasks 1, 2, and 4.
