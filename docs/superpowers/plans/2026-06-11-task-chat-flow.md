# Interactive Task Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the headless orchestrator dispatch so that picking a model for a Kanban task creates a linked chat thread, navigates to it, and auto-sends a seeded task prompt — letting the user steer the work interactively.

**Architecture:** A new nullable `tasks.thread_id` column links a task to its chat. The frontend "Run task" handler creates a thread, links it, and seeds a first message that `ChatPanel` auto-sends exactly once. Card clicks branch on `thread_id` (reopen chat vs edit). The backend's 5-second poll/dispatch loop and its `/start` endpoint are removed; `agent_runs` + `/agents/status` stay.

**Tech Stack:** React + TypeScript (Vite, Vitest, Testing Library) frontend; Fastify + better-sqlite3 backend (node:test via `tsx --test`); `@nexus/shared` workspace for shared types.

**Design reference:** `docs/superpowers/specs/2026-06-11-task-chat-flow-design.md`

**Branch:** `feat/task-chat-flow` (already checked out; spec already committed).

---

## File Structure

**Backend**
- `src/backend/db.ts` — add `thread_id` to `tasks` CREATE TABLE + idempotent migration.
- `src/backend/routes/projects.ts` — allow `thread_id` in `PUT /api/tasks/:id`.
- `src/backend/routes/orchestrator.ts` — delete the `POST /api/orchestrator/tasks/:taskId/start` handler (keep `/agents/status`, `/agents/runs/:taskId`).
- `src/backend/index.ts` — remove the `startOrchestrator` import + call.
- `src/backend/orchestrator/index.ts` — delete file (dead after the poll loop is removed).
- `src/backend/test/db.test.ts` — add a `tasks.thread_id` assertion.

**Shared**
- `src/shared/index.ts` — add `thread_id` to the `Task` interface.

**Frontend**
- `src/frontend/src/api.ts` — add `thread_id` to task-update `Pick`; remove the `agents` block.
- `src/frontend/src/lib/taskPrompt.ts` — new: build the seeded prompt from a task + project.
- `src/frontend/src/lib/taskPrompt.test.ts` — new: unit test the builder.
- `src/frontend/src/components/ChatPanel.tsx` — add `seed` / `onSeedConsumed` props + auto-send-once effect; let `submit` accept a `modelKey` override.
- `src/frontend/src/components/ChatPanel.test.tsx` — add seed-once test.
- `src/frontend/src/components/TaskModelPicker.tsx` — renamed from `OrchestratorModelPicker.tsx`, new copy.
- `src/frontend/src/components/KanbanBoard.tsx` — conditional card click + edit/chat affordances for linked cards.
- `src/frontend/src/components/KanbanBoard.test.tsx` — add conditional-click tests.
- `src/frontend/src/App.tsx` — `seed` state, `handleRunTask`, `handleOpenChat`, conditional card wiring, render `TaskModelPicker`, pass `seed` to `ChatPanel`.

---

## Task 1: Backend — `tasks.thread_id` column + migration

**Files:**
- Modify: `src/backend/db.ts` (CREATE TABLE tasks near line 39; migration block near line 225)
- Test: `src/backend/test/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/backend/test/db.test.ts`:

```typescript
test('tasks has a thread_id column linking to a chat thread', () => {
  const base = join(tmpdir(), `nexus-dbtest-tid-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(cols.includes('thread_id'), 'thread_id column present on tasks');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/db.test.ts`
Expected: FAIL — `thread_id column present on tasks` assertion fails.

- [ ] **Step 3: Add the column to the CREATE TABLE and a migration**

In `src/backend/db.ts`, inside the `CREATE TABLE IF NOT EXISTS tasks (...)` block, add a `thread_id TEXT` column (nullable, no FK constraint to keep the migration path simple). For example add this line alongside the other task columns:

```sql
      thread_id TEXT,
```

Then, next to the existing `model_key` migration (the block that does `ALTER TABLE tasks ADD COLUMN model_key TEXT`), add an idempotent migration so existing databases gain the column:

```typescript
  // Task ↔ chat link — the "In Progress" model picker now opens an
  // interactive chat instead of dispatching headlessly. Store the linked
  // thread so the card can reopen its conversation.
  if (!taskCols.some((c) => c.name === 'thread_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN thread_id TEXT');
  }
```

(`taskCols` is already computed for the `model_key` migration; reuse it. If it is scoped such that it isn't in range here, recompute with `const taskCols2 = db.pragma('table_info(tasks)') as { name: string }[];` and guard on `taskCols2`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/db.test.ts`
Expected: PASS — all tests including the new `thread_id` assertion.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db.ts src/backend/test/db.test.ts
git commit -m "feat(db): add tasks.thread_id column for task-chat link"
```

---

## Task 2: Backend — allow `thread_id` on task update

**Files:**
- Modify: `src/backend/routes/projects.ts:179-197` (PUT /api/tasks/:id)

- [ ] **Step 1: Add `thread_id` to the update body type and the UPDATE**

In `src/backend/routes/projects.ts`, change the `PUT /api/tasks/:id` handler. Update the body type (line ~181):

```typescript
    const body = request.body as { title?: string; description?: string; status?: TaskStatus; priority?: string; assigned_agent?: string; due_date?: string; thread_id?: string };
```

And the UPDATE statement (line ~191) to include `thread_id` via COALESCE:

```typescript
    db.prepare('UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), priority = COALESCE(?, priority), assigned_agent = COALESCE(?, assigned_agent), due_date = COALESCE(?, due_date), thread_id = COALESCE(?, thread_id), updated_at = ? WHERE id = ?')
      .run(body.title, body.description, body.status, body.priority, body.assigned_agent, body.due_date, body.thread_id, now, id);
```

- [ ] **Step 2: Typecheck the backend**

Run: `cd src/backend && npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/backend/routes/projects.ts
git commit -m "feat(api): accept thread_id in PUT /api/tasks/:id"
```

---

## Task 3: Backend — remove the orchestrator poll, dispatch, and `/start`

**Files:**
- Modify: `src/backend/index.ts` (remove import line ~25 and call line ~48)
- Modify: `src/backend/routes/orchestrator.ts` (delete the `/start` handler)
- Delete: `src/backend/orchestrator/index.ts`

- [ ] **Step 1: Remove the dispatch loop from boot**

In `src/backend/index.ts`, delete the import:

```typescript
import { startOrchestrator } from './orchestrator/index.js';
```

and delete the call (line ~48):

```typescript
  startOrchestrator(db, pi);
```

- [ ] **Step 2: Delete the dispatch implementation file**

Run: `git rm src/backend/orchestrator/index.ts`
(Confirm nothing else imports it — `grep -rn "orchestrator/index" src/backend --include=*.ts` should return only the dist build, which is regenerated.)

- [ ] **Step 3: Remove the `/start` endpoint**

In `src/backend/routes/orchestrator.ts`, delete the entire `fastify.post('/api/orchestrator/tasks/:taskId/start', ...)` handler. Keep `GET /api/agents/status` and `GET /api/agents/runs/:taskId` exactly as they are.

- [ ] **Step 4: Typecheck and run backend tests**

Run: `cd src/backend && npm run typecheck && npm test`
Expected: PASS — typecheck clean, all node:test suites green. (No suite depends on the deleted dispatch loop.)

- [ ] **Step 5: Commit**

```bash
git add src/backend/index.ts src/backend/routes/orchestrator.ts src/backend/orchestrator/index.ts
git commit -m "refactor(orchestrator): remove headless poll/dispatch and /start endpoint"
```

---

## Task 4: Shared — add `thread_id` to the `Task` type

**Files:**
- Modify: `src/shared/index.ts` (Task interface, near line 38 after `model_key`)

- [ ] **Step 1: Add the field**

In `src/shared/index.ts`, inside `export interface Task { ... }`, add after the `model_key` field:

```typescript
  /** Set when the "In Progress" model picker opens an interactive chat for
   *  this task. Clicking the card reopens this thread. Null until run. */
  thread_id: string | null;
```

- [ ] **Step 2: Build the shared package**

Run: `npm run --workspace=src/shared build`
Expected: PASS — emits updated `dist` so backend/frontend consumers see the new field.

- [ ] **Step 3: Commit**

```bash
git add src/shared/index.ts src/shared/dist
git commit -m "feat(shared): add Task.thread_id"
```

---

## Task 5: Frontend API — `thread_id` on update, drop `agents.startTask`

**Files:**
- Modify: `src/frontend/src/api.ts` (tasks.update Pick line ~95; agents block line ~99)

- [ ] **Step 1: Add `thread_id` to the update Pick**

In `src/frontend/src/api.ts`, change the `tasks.update` signature:

```typescript
    update: (id: string, data: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assigned_agent' | 'due_date' | 'model_key' | 'thread_id'>>) =>
      fetchJson<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
```

- [ ] **Step 2: Remove the now-unused `agents` block**

Delete the entire `agents: { ... startTask ... },` block (the one that POSTs to `/api/orchestrator/tasks/${taskId}/start`). Leave `models`, `chat`, `projects`, `tasks` intact.

- [ ] **Step 3: Typecheck the frontend**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: FAIL — `App.tsx` still references `api.agents.startTask` (fixed in Task 10). This is expected at this point; continue.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/api.ts
git commit -m "feat(api-client): add thread_id to task update; remove agents.startTask"
```

---

## Task 6: Frontend — seeded task-prompt builder

**Files:**
- Create: `src/frontend/src/lib/taskPrompt.ts`
- Test: `src/frontend/src/lib/taskPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/lib/taskPrompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildTaskPrompt } from './taskPrompt';

describe('buildTaskPrompt', () => {
  it('includes the task title, description, priority and project working dir', () => {
    const prompt = buildTaskPrompt(
      { title: 'Fix login bug', description: 'Users get 500 on submit', priority: 'high' },
      { name: 'Nexus', description: 'Agent console', repo_path: '/repo/nexus' },
    );
    expect(prompt).toContain('## Task: Fix login bug');
    expect(prompt).toContain('Users get 500 on submit');
    expect(prompt).toContain('Priority: high');
    expect(prompt).toContain('/repo/nexus');
  });

  it('omits the description line when there is no description', () => {
    const prompt = buildTaskPrompt(
      { title: 'Tidy imports', description: '', priority: 'low' },
      { name: 'Nexus', description: '', repo_path: '/repo/nexus' },
    );
    expect(prompt).toContain('## Task: Tidy imports');
    expect(prompt).not.toContain('undefined');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && npx vitest run src/lib/taskPrompt.test.ts`
Expected: FAIL — cannot resolve `./taskPrompt`.

- [ ] **Step 3: Implement the builder**

Create `src/frontend/src/lib/taskPrompt.ts`:

```typescript
/**
 * Build the first user message for a task chat. Mirrors the prompt the old
 * headless orchestrator used, but as a normal, visible chat message.
 */
export interface TaskPromptTask {
  title: string;
  description: string;
  priority: string;
}

export interface TaskPromptProject {
  name: string;
  description: string;
  repo_path: string;
}

export function buildTaskPrompt(task: TaskPromptTask, project: TaskPromptProject): string {
  const parts: string[] = [];
  parts.push('You are a coding agent working on a task in this project.');
  parts.push(`Project: ${project.name}`);
  if (project.description) parts.push(project.description);
  parts.push(`Working directory: ${project.repo_path}`);
  parts.push(`Priority: ${task.priority}`);
  parts.push('');
  parts.push(`## Task: ${task.title}`);
  if (task.description) parts.push(task.description);
  parts.push('');
  parts.push('Work through this task in the project working directory. Ask me when you need a decision.');
  return parts.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx vitest run src/lib/taskPrompt.test.ts`
Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/lib/taskPrompt.ts src/frontend/src/lib/taskPrompt.test.ts
git commit -m "feat(frontend): add seeded task-prompt builder"
```

---

## Task 7: Frontend — ChatPanel seed prop (auto-send once)

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx` (props near line 25-36; submit near line 189; add effect near the other thread effects)
- Test: `src/frontend/src/components/ChatPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/frontend/src/components/ChatPanel.test.tsx` (inside the `describe('ChatPanel', ...)` block):

```typescript
  it('auto-sends a seeded prompt exactly once', async () => {
    const encoder = new TextEncoder();
    let streamCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        streamCalls += 1;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
              controller.close();
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    const onSeedConsumed = vi.fn();
    const { rerender } = render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
        seed={{ threadId: 't1', prompt: 'Seeded task prompt', modelKey: 'anthropic/sonnet-4-5' }}
        onSeedConsumed={onSeedConsumed}
      />,
    );

    await waitFor(() => {
      expect(within(screen.getByTestId('chat-messages')).getByText('Seeded task prompt')).toBeInTheDocument();
    });
    expect(onSeedConsumed).toHaveBeenCalledTimes(1);

    // Re-render with the same seed; it must NOT fire a second stream.
    rerender(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
        seed={{ threadId: 't1', prompt: 'Seeded task prompt', modelKey: 'anthropic/sonnet-4-5' }}
        onSeedConsumed={onSeedConsumed}
      />,
    );
    expect(streamCalls).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && npx vitest run src/components/ChatPanel.test.tsx -t "auto-sends a seeded prompt"`
Expected: FAIL — `ChatPanel` does not accept `seed`/`onSeedConsumed` and never auto-sends.

- [ ] **Step 3: Add the props and the auto-send effect**

In `src/frontend/src/components/ChatPanel.tsx`:

(a) Extend the props interface (the `ChatPanelProps` interface, around line 25):

```typescript
interface ChatPanelProps {
  projectId: string;
  threadId: string | null;
  onBusyConflict: (activeThreadId: string, activeTitle: string) => void;
  onThreadsChanged?: () => void;
  onSessionActivityChange?: (threadId: string, active: boolean) => void;
  /** When set and matching the active thread, the prompt is auto-sent once. */
  seed?: { threadId: string; prompt: string; modelKey: string };
  onSeedConsumed?: () => void;
}
```

(b) Destructure the new props (line ~36):

```typescript
export default function ChatPanel({ projectId, threadId, onBusyConflict, onThreadsChanged, onSessionActivityChange, seed, onSeedConsumed }: ChatPanelProps) {
```

(c) Add `parseModelKey` to the existing `useModels` import at the top of the file:

```typescript
import { useModels, parseModelKey } from '../hooks/useModels';
```

(If `useModels` is imported from a different specifier, add `parseModelKey` to whichever existing import already pulls from `../hooks/useModels`; it is exported there.)

(d) Let `submit` accept a `modelKey` override (line ~189). Change the options type and the `startStream` call:

```typescript
  const submit = useCallback(
    async (text: string, opts: { confirmCancel?: boolean; modelKey?: string } = {}) => {
      if (!threadId) return;
      setError(null);
      try {
        await startStream(threadId, text, { confirmCancel: opts.confirmCancel, modelKey: opts.modelKey ?? activeModelId });
        onThreadsChanged?.();
        const msgs = await fetchThreadMessages(threadId);
        if (msgs.length > 0) {
          dispatch({ type: 'RESET' });
          setLoadedMessages(msgs);
        }
      } catch (err) {
        if (err instanceof ChatBusyError) {
          setPendingConfirm({
            activeThreadId: err.activeThreadId,
            activeTitle: err.activeTitle,
            pendingText: text,
          });
          onBusyConflict(err.activeThreadId, err.activeTitle);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [threadId, startStream, onBusyConflict, onThreadsChanged, activeModelId, fetchThreadMessages, dispatch],
  );
```

(e) Add a seed ref near the other `useRef`s (around line 45):

```typescript
  const seededThreadRef = useRef<string | null>(null);
```

(f) Add the auto-send effect AFTER `submit` is defined (place it just below the `submit` `useCallback`, around line 215):

```typescript
  // Auto-send a seeded task prompt exactly once when the chat opens for it.
  useEffect(() => {
    if (!seed || !threadId || seed.threadId !== threadId) return;
    if (seededThreadRef.current === threadId) return;
    seededThreadRef.current = threadId;
    const parsed = parseModelKey(seed.modelKey);
    if (parsed) setModel(parsed.provider, parsed.id);
    void submit(seed.prompt, { modelKey: seed.modelKey });
    onSeedConsumed?.();
  }, [seed, threadId, submit, setModel, onSeedConsumed]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx vitest run src/components/ChatPanel.test.tsx`
Expected: PASS — all ChatPanel tests including seed-once. `streamCalls` stays 1 across the re-render.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/ChatPanel.tsx src/frontend/src/components/ChatPanel.test.tsx
git commit -m "feat(chat): auto-send a seeded task prompt once"
```

---

## Task 8: Frontend — rename picker to `TaskModelPicker` + new copy

**Files:**
- Rename: `src/frontend/src/components/OrchestratorModelPicker.tsx` → `src/frontend/src/components/TaskModelPicker.tsx`
- (App import is updated in Task 10.)

- [ ] **Step 1: Rename the file via git**

Run: `git mv src/frontend/src/components/OrchestratorModelPicker.tsx src/frontend/src/components/TaskModelPicker.tsx`

- [ ] **Step 2: Rename the component and update copy**

In `src/frontend/src/components/TaskModelPicker.tsx`:

Change the export name:

```typescript
export function TaskModelPicker({ open, onPick, onClose }: Props) {
```

Update the header/description copy:

```tsx
        <div>
          <h3 className="text-sm font-semibold text-primary">Pick a model for this task</h3>
          <p className="text-xs text-faint mt-1">
            A new chat opens with this task and the agent starts working. You can guide it as it goes.
          </p>
        </div>
```

Leave the `data-testid="orchestrator-picker"` and `data-testid="orchestrator-picker-run"` attributes unchanged (any existing tests/selectors keep working). Also update the file's top-of-file doc comment to describe the chat flow instead of headless dispatch.

- [ ] **Step 3: Typecheck (expect the App import to still point at the old name)**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: FAIL — `App.tsx` still imports `OrchestratorModelPicker`. Fixed in Task 10.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/TaskModelPicker.tsx
git commit -m "refactor(frontend): rename picker to TaskModelPicker with chat-flow copy"
```

---

## Task 9: Frontend — KanbanBoard conditional card click

**Files:**
- Modify: `src/frontend/src/components/KanbanBoard.tsx` (props near line 3-11; card click near line 76; card footer near line 85-99)
- Test: `src/frontend/src/components/KanbanBoard.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/frontend/src/components/KanbanBoard.test.tsx`. First add a linked-task fixture near the top (after the existing `task` constant):

```typescript
const linkedTask: Task = {
  ...task,
  id: 'task-2',
  title: 'Linked running task',
  status: 'in_progress',
  thread_id: 'thread-9',
};
```

Then add tests inside the `describe('KanbanBoard', ...)` block. Import `userEvent` at the top of the file (`import userEvent from '@testing-library/user-event';`) if not already present:

```typescript
  it('reopens the chat (not edit) when an unlinked-vs-linked card is clicked', async () => {
    const onEditTask = vi.fn();
    const onOpenChat = vi.fn();
    render(
      <KanbanBoard
        tasks={[task, linkedTask]}
        columns={['triage', 'in_progress']}
        columnLabels={{ triage: 'Triage', in_progress: 'In Progress' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onEditTask={onEditTask}
        onOpenChat={onOpenChat}
        onDeleteTask={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText('Linked running task'));
    expect(onOpenChat).toHaveBeenCalledWith(linkedTask);
    expect(onEditTask).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('Design ambient board'));
    expect(onEditTask).toHaveBeenCalledWith(task);
  });

  it('shows an edit affordance on linked cards', () => {
    render(
      <KanbanBoard
        tasks={[linkedTask]}
        columns={['in_progress']}
        columnLabels={{ in_progress: 'In Progress' } as Record<string, string>}
        onMoveTask={vi.fn()}
        onAddTask={vi.fn()}
        onEditTask={vi.fn()}
        onOpenChat={vi.fn()}
        onDeleteTask={vi.fn()}
      />,
    );
    expect(screen.getByTestId('edit-task-task-2')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/frontend && npx vitest run src/components/KanbanBoard.test.tsx`
Expected: FAIL — `onOpenChat` prop and `edit-task-*` testid do not exist yet.

- [ ] **Step 3: Add the `onOpenChat` prop and conditional behavior**

In `src/frontend/src/components/KanbanBoard.tsx`:

(a) Extend the props interface:

```typescript
interface KanbanBoardProps {
  tasks: Task[];
  columns: TaskStatus[];
  columnLabels: Record<TaskStatus, string>;
  onMoveTask: (taskId: string, newStatus: TaskStatus) => void;
  onAddTask: (status: TaskStatus) => void;
  onEditTask: (task: Task) => void;
  onOpenChat: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
}
```

(b) Destructure `onOpenChat`:

```typescript
export default function KanbanBoard({ tasks, columns, columnLabels, onMoveTask, onAddTask, onEditTask, onOpenChat, onDeleteTask }: KanbanBoardProps) {
```

(c) Change the card `onClick` (line ~76) to branch on `thread_id`:

```tsx
                  onClick={() => (task.thread_id ? onOpenChat(task) : onEditTask(task))}
```

(d) In the card footer actions (the `flex items-center justify-between` block around line 85-99), add — for linked cards only — a chat glyph and an edit button, placed before the existing delete button. Replace the trailing delete `<button>` region with:

```tsx
                    <div className="flex items-center gap-2 ml-auto">
                      {task.thread_id && (
                        <>
                          <span
                            data-testid={`chat-glyph-${task.id}`}
                            title="Has a chat"
                            className="text-faint/60 text-xs"
                          >
                            💬
                          </span>
                          <button
                            data-testid={`edit-task-${task.id}`}
                            onClick={(e) => { e.stopPropagation(); onEditTask(task); }}
                            title="Edit task"
                            className="text-faint/40 hover:text-[var(--text-primary)] text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            ✎
                          </button>
                        </>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
                        className="text-faint/40 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                    </div>
```

Keep the left-hand `assigned_agent` badge block (`<div className="flex gap-1">...`) as-is; only the right-hand delete button is replaced by the grouped actions above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/frontend && npx vitest run src/components/KanbanBoard.test.tsx`
Expected: PASS — all KanbanBoard tests, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/KanbanBoard.tsx src/frontend/src/components/KanbanBoard.test.tsx
git commit -m "feat(kanban): reopen chat on linked card click; edit affordance for linked cards"
```

---

## Task 10: Frontend — wire App (`handleRunTask`, seed, open-chat)

**Files:**
- Modify: `src/frontend/src/App.tsx` (import line ~17; state near line ~33; handlers near line ~226; KanbanBoard render line ~358; ChatPanel render line ~370; picker render line ~468)

- [ ] **Step 1: Update imports**

In `src/frontend/src/App.tsx`, replace the picker import (line ~17):

```typescript
import { TaskModelPicker } from './components/TaskModelPicker';
```

Add the prompt builder import near the other local imports:

```typescript
import { buildTaskPrompt } from './lib/taskPrompt';
```

- [ ] **Step 2: Add seed state**

Near the other `useState` declarations (after `orchestratorPicker`, line ~33):

```typescript
  const [seed, setSeed] = useState<{ threadId: string; prompt: string; modelKey: string } | null>(null);
```

- [ ] **Step 3: Replace `handleOrchestratorPick` with `handleRunTask`**

Delete the existing `handleOrchestratorPick` (lines ~226-236, the one calling `api.agents.startTask`) and replace with:

```typescript
  const handleRunTask = async (modelKey: string) => {
    if (!orchestratorPicker || !activeProjectId || !activeProject) return;
    const { taskId } = orchestratorPicker;
    setOrchestratorPicker(null);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    // Already linked → just reopen its chat (no duplicate thread).
    if (task.thread_id) {
      selectThread(activeProjectId, task.thread_id);
      return;
    }

    try {
      const thread = await api.chat.createThread(activeProjectId, task.title);
      await api.tasks.update(taskId, { status: 'in_progress', thread_id: thread.id });
      const prompt = buildTaskPrompt(
        { title: task.title, description: task.description, priority: task.priority },
        { name: activeProject.name, description: activeProject.description, repo_path: activeProject.repo_path },
      );
      setSeed({ threadId: thread.id, prompt, modelKey });
      await loadThreads(activeProjectId);
      await loadTasks(activeProjectId);
      selectThread(activeProjectId, thread.id);
    } catch (err) {
      console.error('Failed to start task chat', err);
    }
  };

  const handleOpenChat = (task: Task) => {
    if (activeProjectId && task.thread_id) selectThread(activeProjectId, task.thread_id);
  };
```

(`Project` in `@nexus/shared` has `name`, `description`, and `repo_path` as required strings, so all three are passed directly.)

- [ ] **Step 4: Wire KanbanBoard**

In the KanbanBoard render (line ~358), replace `onEditTask={() => setEditingTask(task)}`-style wiring and add `onOpenChat`:

```tsx
            <KanbanBoard
              tasks={tasks}
              columns={KANBAN_COLUMNS}
              columnLabels={KANBAN_COLUMN_LABELS}
              onMoveTask={handleMoveTask}
              onAddTask={(status) => setTaskModalColumn(status)}
              onEditTask={(task) => setEditingTask(task)}
              onOpenChat={handleOpenChat}
              onDeleteTask={handleDeleteTask}
            />
```

- [ ] **Step 5: Pass `seed` to ChatPanel**

In the ChatPanel render (line ~370), add the seed props:

```tsx
                <ChatPanel
                  key={activeProject.id}
                  projectId={activeProject.id}
                  threadId={activeThreadId}
                  onBusyConflict={() => {}}
                  onThreadsChanged={() => loadThreads(activeProject.id)}
                  onSessionActivityChange={handleSessionActivityChange}
                  seed={seed ?? undefined}
                  onSeedConsumed={() => setSeed(null)}
                />
```

- [ ] **Step 6: Update the picker render**

Replace the `OrchestratorModelPicker` render (line ~468) with:

```tsx
      {orchestratorPicker && (
        <TaskModelPicker
          open={true}
          onPick={handleRunTask}
          onClose={() => setOrchestratorPicker(null)}
        />
      )}
```

- [ ] **Step 7: Typecheck the frontend**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: PASS — all earlier-task references (`api.agents.startTask`, `OrchestratorModelPicker`) are now resolved.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/App.tsx
git commit -m "feat(app): run tasks as interactive seeded chats; reopen linked chats"
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Frontend typecheck + tests**

Run: `cd src/frontend && npx tsc --noEmit && npx vitest run`
Expected: PASS — typecheck clean; all suites green (ModelSelector, KanbanBoard, ChatPanel, taskPrompt, others).

- [ ] **Step 2: Backend typecheck + tests**

Run: `cd src/backend && npm run typecheck && npm test`
Expected: PASS — typecheck clean; node:test suites green including the new `tasks.thread_id` assertion.

- [ ] **Step 3: Root typecheck**

Run: `npm run typecheck`
Expected: PASS — shared, backend, frontend all clean.

- [ ] **Step 4: Manual smoke (preview)**

Start the app (`npm run dev`), then:
1. Create a task in Triage; drag it to In Progress → the model picker appears with the new copy.
2. Pick a model, click **Run task** → the view switches to a new chat titled after the task, and the seeded task prompt is auto-sent (agent starts streaming).
3. Return to the board → the card sits in In Progress with a 💬 glyph; clicking it reopens the same chat. Hover shows the ✎ edit button, which opens the edit modal.
4. Confirm the dropdown in the picker opens in-place (the earlier portal fix) and nothing dispatches headlessly (no second run; Mission Control shows no new headless task run).

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test: verify task-chat flow end to end"
```

---

## Self-Review Notes

- **Spec coverage:** Run flow (Task 10), task↔chat link + conditional click (Tasks 1,4,9,10), seed mechanism (Tasks 6,7,10), removal scope (Tasks 3,5), picker copy/rename (Task 8), types (Task 4), tests (Tasks 1,6,7,9). All spec sections map to tasks.
- **Out of scope:** memory/Obsidian summary intentionally omitted (tracked by chip "Summarize task chats into memory").
- **Type consistency:** `seed` shape `{ threadId, prompt, modelKey }` is identical in App state (Task 10), the `ChatPanel` prop (Task 7), and the seed effect. `onOpenChat(task: Task)` matches between KanbanBoard (Task 9) and App (Task 10). `thread_id: string | null` is consistent across shared type (Task 4), DB column (Task 1), and update API (Tasks 2,5).
- **Expected interim failures:** Tasks 5 and 8 leave the frontend typecheck red on purpose (App still references old symbols); Task 10 resolves them. This ordering keeps each commit focused.
