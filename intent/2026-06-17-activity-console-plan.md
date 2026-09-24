# Activity Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline execution — no subagents available in this environment).

**Goal:** Build a backend activity event bus + SQLite `operations` table and a frontend Activity Console that shows running/recent Nexus work with controls.

**Architecture:** Subsystems emit `activity:start/update/stop` events into an in-process `ActivityBus`. A single `ActivityManager` persists them to SQLite and keeps a running set. The frontend polls `GET /api/activity` every 15s and renders a dense table + detail panel.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, Tailwind, Vitest, node:test.

---

## File structure

| File | Responsibility |
|---|---|
| `src/backend/db.ts` | Add `operations` table and indexes |
| `src/backend/activity/events.ts` | Typed event bus (`ActivityBus`) |
| `src/backend/activity/manager.ts` | `ActivityManager` persistence + running set |
| `src/backend/routes/activity.ts` | `/api/activity` REST routes |
| `src/backend/fastify.d.ts` | Add `activity` decorator type |
| `src/backend/index.ts` | Wire manager, bus, routes, startup sweep |
| `src/backend/routes/chat.ts` | Emit `chat_turn` and `memory_archive` events |
| `src/backend/routes/assistant.ts` | Emit `assistant_stream` events |
| `src/backend/jira/poll.ts` | Emit `jira_sync` events |
| `src/backend/routes/projects.ts` | Emit `github_sync` events around `syncGitHubIssues` |
| `src/backend/test/activity-manager.test.ts` | Manager unit tests |
| `src/backend/test/routes-activity.test.ts` | Route tests |
| `src/frontend/src/api.ts` | Activity API client types |
| `src/frontend/src/components/ActivityConsole.tsx` | Activity console UI |
| `src/frontend/src/components/ActivityConsole.test.tsx` | UI tests |
| `src/frontend/src/components/TopBar.tsx` | Add Activity nav tab |
| `src/frontend/src/App.tsx` | Add global view + command palette entry |

---

## Task 1: Database migration

**Files:**
- Modify: `src/backend/db.ts`

- [ ] **Step 1: Add operations table + indexes**

Append to the main `CREATE TABLE IF NOT EXISTS` block:

```sql
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  task_id TEXT,
  thread_id TEXT,
  provider TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER DEFAULT 0,
  usage_json TEXT,
  last_event TEXT,
  error TEXT,
  diagnostics_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
CREATE INDEX IF NOT EXISTS idx_operations_kind ON operations(kind);
CREATE INDEX IF NOT EXISTS idx_operations_started_at ON operations(started_at);
CREATE INDEX IF NOT EXISTS idx_operations_project_id ON operations(project_id);
CREATE INDEX IF NOT EXISTS idx_operations_thread_id ON operations(thread_id);
```

- [ ] **Step 2: Verify schema builds**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/backend 2>&1 | tail -20`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/db.ts
git commit -m "feat: add operations table for activity console"
```

---

## Task 2: Activity event bus

**Files:**
- Create: `src/backend/activity/events.ts`

- [ ] **Step 1: Write event bus + types**

```typescript
export type OperationKind =
  | 'chat_turn'
  | 'assistant_stream'
  | 'jira_sync'
  | 'github_sync'
  | 'memory_archive'
  | 'memory_index';

export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ActivityEvent {
  type: 'start' | 'update' | 'stop';
  operationId: string;
  kind: OperationKind;
  title: string;
  projectId?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: OperationStatus;
  durationMs?: number;
  usage?: unknown;
  lastEvent?: string;
  error?: string;
  diagnostics?: unknown;
}

export type ActivityListener = (event: ActivityEvent) => void;

export class ActivityBus {
  private listeners: ActivityListener[] = [];

  subscribe(listener: ActivityListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  emit(event: ActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[activity] listener failed:', err);
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/activity/events.ts
git commit -m "feat: add activity event bus"
```

---

## Task 3: Activity manager

**Files:**
- Create: `src/backend/activity/manager.ts`

- [ ] **Step 1: Write ActivityManager**

```typescript
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { ActivityBus, ActivityEvent, OperationKind, OperationStatus } from './events.js';

export interface RunningOperation {
  id: string;
  kind: OperationKind;
  startedAt: number;
}

export class ActivityManager {
  readonly bus = new ActivityBus();
  private readonly running = new Map<string, RunningOperation>();
  private readonly insert: Database.Statement;
  private readonly update: Database.Statement;
  private readonly finish: Database.Statement;
  private readonly sweep: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO operations (id, kind, status, title, project_id, task_id, thread_id, provider, model, started_at, usage_json, last_event, error, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.update = db.prepare(
      `UPDATE operations SET usage_json = ?, last_event = ?, error = ?, diagnostics_json = ? WHERE id = ?`
    );
    this.finish = db.prepare(
      `UPDATE operations SET status = ?, completed_at = ?, duration_ms = ?, usage_json = ?, last_event = ?, error = ?, diagnostics_json = ? WHERE id = ?`
    );
    this.sweep = db.prepare(
      `UPDATE operations SET status = 'cancelled', completed_at = ?, duration_ms = COALESCE(duration_ms, 0), error = COALESCE(error, '') || ' · process restarted' WHERE status = 'running'`
    );
  }

  startListening(): () => void {
    this.sweepRunning();
    return this.bus.subscribe((event) => this.handleEvent(event));
  }

  private sweepRunning(): void {
    const now = new Date().toISOString();
    this.sweep.run(now);
  }

  private handleEvent(event: ActivityEvent): void {
    try {
      if (event.type === 'start') this.handleStart(event);
      else if (event.type === 'update') this.handleUpdate(event);
      else if (event.type === 'stop') this.handleStop(event);
    } catch (err) {
      console.error('[activity] failed to handle event:', err);
    }
  }

  private handleStart(event: ActivityEvent): void {
    const now = new Date().toISOString();
    this.insert.run(
      event.operationId,
      event.kind,
      'running',
      event.title,
      event.projectId ?? null,
      event.taskId ?? null,
      event.threadId ?? null,
      event.provider ?? null,
      event.model ?? null,
      now,
      event.usage ? JSON.stringify(event.usage) : null,
      event.lastEvent ?? null,
      event.error ?? null,
      event.diagnostics ? JSON.stringify(event.diagnostics) : null,
    );
    this.running.set(event.operationId, { id: event.operationId, kind: event.kind, startedAt: Date.now() });
  }

  private handleUpdate(event: ActivityEvent): void {
    this.update.run(
      event.usage ? JSON.stringify(event.usage) : null,
      event.lastEvent ?? null,
      event.error ?? null,
      event.diagnostics ? JSON.stringify(event.diagnostics) : null,
      event.operationId,
    );
  }

  private handleStop(event: ActivityEvent): void {
    const started = this.running.get(event.operationId)?.startedAt;
    const durationMs = started ? Date.now() - started : event.durationMs ?? 0;
    const now = new Date().toISOString();
    this.finish.run(
      event.status ?? 'succeeded',
      now,
      durationMs,
      event.usage ? JSON.stringify(event.usage) : null,
      event.lastEvent ?? null,
      event.error ?? null,
      event.diagnostics ? JSON.stringify(event.diagnostics) : null,
      event.operationId,
    );
    this.running.delete(event.operationId);
  }

  getRunning(): RunningOperation[] {
    return Array.from(this.running.values());
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }
}
```

- [ ] **Step 2: Build**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/backend 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/activity/manager.ts
git commit -m "feat: add ActivityManager persistence and running set"
```

---

## Task 4: Wire ActivityManager into backend bootstrap

**Files:**
- Modify: `src/backend/fastify.d.ts`
- Modify: `src/backend/index.ts`

- [ ] **Step 1: Add decorator type**

In `src/backend/fastify.d.ts`, add to `FastifyInstance`:

```typescript
import type { ActivityManager } from './activity/manager.js';

interface FastifyInstance {
  // ... existing decorators
  activity: ActivityManager;
}
```

- [ ] **Step 2: Instantiate and decorate in index.ts**

In `src/backend/index.ts`:

```typescript
import { ActivityManager } from './activity/manager.js';
import { registerActivityRoutes } from './routes/activity.js';
```

After `app.decorate('db', db);`:

```typescript
const activityManager = new ActivityManager(db);
activityManager.startListening();
app.decorate('activity', activityManager);
```

Register routes:

```typescript
app.register(registerActivityRoutes);
```

- [ ] **Step 3: Build**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/backend 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/fastify.d.ts src/backend/index.ts
git commit -m "feat: wire ActivityManager into fastify"
```

---

## Task 5: Activity API routes

**Files:**
- Create: `src/backend/routes/activity.ts`

- [ ] **Step 1: Write routes**

```typescript
import { FastifyInstance } from 'fastify';
import { OperationKind, OperationStatus } from '../activity/events.js';

const VALID_KINDS: OperationKind[] = [
  'chat_turn',
  'assistant_stream',
  'jira_sync',
  'github_sync',
  'memory_archive',
  'memory_index',
];
const VALID_STATUSES: OperationStatus[] = ['running', 'succeeded', 'failed', 'cancelled'];

export async function registerActivityRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const activity = fastify.activity;

  fastify.get('/api/activity', async (request) => {
    const query = request.query as { status?: string; kind?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const kindFilter = VALID_KINDS.includes(query.kind as OperationKind) ? (query.kind as OperationKind) : undefined;
    const statusFilter = VALID_STATUSES.includes(query.status as OperationStatus) ? (query.status as OperationStatus) : undefined;

    const runningIds = activity.getRunning().map((r) => r.id);
    const runningParams: (string | number)[] = [];
    let runningWhere = '';
    if (kindFilter) {
      runningWhere += ' AND kind = ?';
      runningParams.push(kindFilter);
    }
    const runningRows = db
      .prepare(`SELECT * FROM operations WHERE status = 'running'${runningWhere} ORDER BY started_at DESC LIMIT ?`)
      .all(...runningParams, limit) as any[];

    const running = runningRows.map((row) => enrichRunning(row, activity));

    const recentParams: (string | number)[] = [];
    let recentWhere = '';
    if (kindFilter) {
      recentWhere += ' AND kind = ?';
      recentParams.push(kindFilter);
    }
    if (statusFilter) {
      recentWhere += ' AND status = ?';
      recentParams.push(statusFilter);
    } else {
      recentWhere += " AND status <> 'running'";
    }
    const recentRows = db
      .prepare(`SELECT * FROM operations WHERE 1=1${recentWhere} ORDER BY started_at DESC LIMIT ?`)
      .all(...recentParams, limit) as any[];

    const counts = db
      .prepare("SELECT status, COUNT(*) AS count FROM operations GROUP BY status")
      .all() as { status: string; count: number }[];

    return {
      running,
      recent: recentRows.map(enrichRow),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
    };
  });

  fastify.get('/api/activity/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    return enrichRow(row);
  });

  fastify.get('/api/activity/:id/diagnostics', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT diagnostics_json, last_event, error FROM operations WHERE id = ?').get(id) as any;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    return {
      diagnostics: parseJson(row.diagnostics_json),
      lastEvent: row.last_event,
      error: row.error,
    };
  });

  fastify.post('/api/activity/:id/abort', async (request, reply) => {
    const { id } = request.params as { id: string };
    const op = activity.getRunning().find((r) => r.id === id) ?? (db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any);
    if (!op) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    const kind = op.kind;
    if (kind === 'chat_turn' && op.thread_id) {
      const existing = (fastify as any).activeChatStreams?.get?.(op.thread_id);
      if (existing) await existing.session.abort();
      return { ok: true };
    }
    if (kind === 'assistant_stream') {
      const res = await (fastify as any).inject({ method: 'POST', url: '/api/assistant/abort' });
      return res.json();
    }
    reply.code(409);
    return { error: `Abort not supported for ${kind}` };
  });

  fastify.post('/api/activity/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    if (row.kind === 'memory_archive' && row.thread_id) {
      const res = await (fastify as any).inject({ method: 'POST', url: `/api/threads/${row.thread_id}/archive` });
      return res.json();
    }
    if (row.kind === 'jira_sync') {
      const res = await (fastify as any).inject({ method: 'POST', url: '/api/jira/sync', payload: { replaceAll: true } });
      return res.json();
    }
    if (row.kind === 'github_sync' && row.project_id) {
      const res = await (fastify as any).inject({ method: 'POST', url: `/api/projects/${row.project_id}/github/sync` });
      return res.json();
    }
    reply.code(409);
    return { error: `Retry not supported for ${row.kind}` };
  });
}

function enrichRunning(row: any, activity: any) {
  const started = activity.getRunning().find((r: any) => r.id === row.id)?.startedAt;
  const durationMs = started ? Date.now() - started : row.duration_ms;
  return { ...enrichRow(row), duration_ms: durationMs };
}

function enrichRow(row: any) {
  return {
    ...row,
    usage: parseJson(row.usage_json),
    diagnostics: parseJson(row.diagnostics_json),
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}
```

Note: `abort` for chat streams uses a new decorator `activeChatStreams` we will add in Task 6.

- [ ] **Step 2: Build**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/backend 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/routes/activity.ts
git commit -m "feat: add activity API routes"
```

---

## Task 6: Emit chat turn and memory archive events

**Files:**
- Modify: `src/backend/routes/chat.ts`

- [ ] **Step 1: Expose active streams to activity abort**

Near the top of `registerChatRoutes`, after `const activeStreams = new Map<string, ActiveStream>();`, decorate fastify:

```typescript
(fastify as any).activeChatStreams = activeStreams;
```

- [ ] **Step 2: Emit chat turn events**

At the start of the stream handler (after `reply.hijack()`), add:

```typescript
const operationId = uuid();
fastify.activity.bus.emit({
  type: 'start',
  operationId,
  kind: 'chat_turn',
  title: `${project?.name ?? 'unknown'} / ${thread.title}`,
  projectId: thread.project_id,
  threadId,
  provider: selectedModel?.provider ?? 'default',
  model: selectedModel?.id ?? body.modelKey ?? 'default',
});
```

When context usage is received (`if (contextUsage) write(...)`), also emit:

```typescript
fastify.activity.bus.emit({
  type: 'update',
  operationId,
  kind: 'chat_turn',
  title: `${project?.name ?? 'unknown'} / ${thread.title}`,
  usage: contextUsage,
  lastEvent: 'context_usage',
});
```

In the `catch` block before writing error, and in the `finally` block on done/error/abort, emit stop. Replace the existing `try/catch/finally` boundaries as needed.

In `finally`:

```typescript
fastify.activity.bus.emit({
  type: 'stop',
  operationId,
  kind: 'chat_turn',
  title: `${project?.name ?? 'unknown'} / ${thread.title}`,
  status: aborted ? 'cancelled' : (streamError ? 'failed' : 'succeeded'),
  error: streamError ?? undefined,
});
```

You will need a `streamError` variable and an `aborted` flag.

- [ ] **Step 3: Emit memory archive events**

In the `/api/threads/:threadId/archive` route, before calling `archiveThreadToMemory`:

```typescript
const operationId = uuid();
fastify.activity.bus.emit({
  type: 'start',
  operationId,
  kind: 'memory_archive',
  title: `${project?.name ?? 'unknown'} / ${thread.title}`,
  projectId: thread.project_id,
  threadId,
  provider: 'local',
  model: 'llama-3.1',
});
```

After it returns:

```typescript
fastify.activity.bus.emit({
  type: 'stop',
  operationId,
  kind: 'memory_archive',
  title: `${project?.name ?? 'unknown'} / ${thread.title}`,
  status: 'succeeded',
  diagnostics: { memoryId: result.memoryId },
});
```

In the catch:

```typescript
fastify.activity.bus.emit({
  type: 'stop',
  operationId,
  kind: 'memory_archive',
  title: `${project?.name ?? 'unknown'} / ${thread.title}`,
  status: 'failed',
  error: err?.message ?? 'Archive failed',
});
```

- [ ] **Step 4: Build**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/backend 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/routes/chat.ts
git commit -m "feat: emit chat_turn and memory_archive activity events"
```

---

## Task 7: Emit assistant stream events

**Files:**
- Modify: `src/backend/routes/assistant.ts`

- [ ] **Step 1: Emit start/stop/update events**

After `activeAssistantAbort = controller;` in `/api/assistant/messages/stream`:

```typescript
const operationId = uuid();
fastify.activity.bus.emit({
  type: 'start',
  operationId,
  kind: 'assistant_stream',
  title: 'Assistant',
  provider: 'assistant',
  model: 'assistant',
});
```

In the `write` helper, track last event. In the `try` success path before `write({ type: 'complete' })`, emit:

```typescript
fastify.activity.bus.emit({
  type: 'stop',
  operationId,
  kind: 'assistant_stream',
  title: 'Assistant',
  status: 'succeeded',
});
```

In the `catch`:

```typescript
fastify.activity.bus.emit({
  type: 'stop',
  operationId,
  kind: 'assistant_stream',
  title: 'Assistant',
  status: err?.name === 'AbortError' ? 'cancelled' : 'failed',
  error: err?.message,
});
```

- [ ] **Step 2: Build + commit**

Run build, then:

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/routes/assistant.ts
git commit -m "feat: emit assistant_stream activity events"
```

---

## Task 8: Emit Jira sync events

**Files:**
- Modify: `src/backend/jira/poll.ts`

- [ ] **Step 1: Emit start/stop**

In `runJiraSyncOnce`, at the top when enabled:

```typescript
const operationId = uuid();
const startEvent = {
  type: 'start' as const,
  operationId,
  kind: 'jira_sync' as const,
  title: 'Jira sync',
};
// We need a way to emit without a fastify instance. Use an injected emitter.
```

Because `runJiraSyncOnce` does not have Fastify, change its signature to accept an optional emitter:

```typescript
export async function runJiraSyncOnce(
  db: Database.Database,
  jira: JiraConfig,
  token: string | undefined,
  fetchTickets: FetchTickets = (cfg, tok) => fetchJiraTickets(cfg, tok),
  emit?: (event: ActivityEvent) => void,
): Promise<SyncResult | null> {
```

Use `emit?.(startEvent)` etc. In `startJiraSync`, pass `activityManager.bus.emit.bind(activityManager.bus)` as the emitter.

- [ ] **Step 2: Wire emitter in startJiraSync**

Change `startJiraSync` signature to accept the manager:

```typescript
export function startJiraSync(db: Database.Database, activity?: ActivityManager): { stop: () => void } {
```

Call `runJiraSyncOnce(db, jira, token, undefined, activity?.bus.emit.bind(activity.bus))`.

- [ ] **Step 3: Update backend/index.ts call**

```typescript
startJiraSync(db, activityManager);
```

- [ ] **Step 4: Build + commit**

Run build, then commit.

---

## Task 9: Emit GitHub sync events

**Files:**
- Modify: `src/backend/routes/projects.ts`
- Modify: `src/backend/github/sync.ts`

- [ ] **Step 1: Add emitter to syncGitHubIssues**

Change signature to accept `emit?: (event: ActivityEvent) => void`.

In `syncGitHubIssues`:

```typescript
const operationId = uuid();
emit?.({ type: 'start', operationId, kind: 'github_sync', title: `GitHub sync · ${project.name}`, projectId: project.id });
```

On success:

```typescript
emit?.({ type: 'stop', operationId, kind: 'github_sync', title: `GitHub sync · ${project.name}`, status: 'succeeded', diagnostics: { created, total } });
clearSyncError(project.id);
```

On error before returning/throwing:

```typescript
emit?.({ type: 'stop', operationId, kind: 'github_sync', title: `GitHub sync · ${project.name}`, status: 'failed', error: err?.message });
```

- [ ] **Step 2: Pass emitter from route**

In `src/backend/routes/projects.ts`:

```typescript
const { created, total } = await syncGitHubIssues(db, project, undefined, fastify.activity.bus.emit.bind(fastify.activity.bus));
```

- [ ] **Step 3: Build + commit**

Run build, then commit.

---

## Task 10: Backend tests

**Files:**
- Create: `src/backend/test/activity-manager.test.ts`
- Create: `src/backend/test/routes-activity.test.ts`

- [ ] **Step 1: Manager unit tests**

Test start/update/stop, startup sweep, and persistence.

- [ ] **Step 2: Route tests**

Build a Fastify app with the activity manager and activity routes. Test GET returns running/recent, unsupported abort returns 409, diagnostics returns payload.

- [ ] **Step 3: Run tests**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm test -w @nexus/backend -- src/backend/test/activity-manager.test.ts src/backend/test/routes-activity.test.ts 2>&1 | tail -40`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/backend/test/activity-manager.test.ts src/backend/test/routes-activity.test.ts
git commit -m "test: activity manager and routes"
```

---

## Task 11: Frontend API types

**Files:**
- Modify: `src/frontend/src/api.ts`

- [ ] **Step 1: Add types and client**

```typescript
export type OperationKind = 'chat_turn' | 'assistant_stream' | 'jira_sync' | 'github_sync' | 'memory_archive' | 'memory_index';
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  title: string;
  project_id: string | null;
  task_id: string | null;
  thread_id: string | null;
  provider: string | null;
  model: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  usage?: unknown;
  last_event: string | null;
  error: string | null;
  diagnostics?: unknown;
}

export interface ActivityResponse {
  running: Operation[];
  recent: Operation[];
  counts: Record<string, number>;
}
```

Add to `api` object:

```typescript
activity: {
  list: (params?: { status?: string; kind?: string; limit?: number }) =>
    fetchJson<ActivityResponse>(`/api/activity${qs(params)}`),
  get: (id: string) => fetchJson<Operation>(`/api/activity/${id}`),
  abort: (id: string) => fetchJson<{ ok: boolean }>(`/api/activity/${id}/abort`, { method: 'POST' }),
  retry: (id: string) => fetchJson<{ ok: boolean }>(`/api/activity/${id}/retry`, { method: 'POST' }),
  diagnostics: (id: string) => fetchJson<{ diagnostics?: unknown; lastEvent?: string; error?: string }>(`/api/activity/${id}/diagnostics`),
},
```

Add a `qs` helper for query strings.

- [ ] **Step 2: Build**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/frontend 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/frontend/src/api.ts
git commit -m "feat: frontend activity API client"
```

---

## Task 12: ActivityConsole UI

**Files:**
- Create: `src/frontend/src/components/ActivityConsole.tsx`

- [ ] **Step 1: Implement dense table + detail panel**

Props:

```typescript
interface ActivityConsoleProps {
  operations: ActivityResponse | null;
  loading: boolean;
  projects: Project[];
  tasks: Task[];
  threads: ThreadMeta[];
  onRefresh: () => void;
  onSelectProject: (id: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onAbort: (id: string) => void;
  onRetry: (id: string) => void;
  onCopyDiagnostics: (id: string) => void;
}
```

Render filters (kind/status/search), table, detail panel. Use existing CSS classes (`surface-glass`, `border-subtle`, `text-muted`, etc).

- [ ] **Step 2: Build**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm run build -w @nexus/frontend 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/frontend/src/components/ActivityConsole.tsx
git commit -m "feat: add ActivityConsole component"
```

---

## Task 13: Wire global navigation

**Files:**
- Modify: `src/frontend/src/components/TopBar.tsx`
- Modify: `src/frontend/src/App.tsx`

- [ ] **Step 1: Add Activity tab to TopBar**

Update `GlobalView` type to include `'activity'`. Add button with a Pulse icon (use `Activity` from Phosphor).

- [ ] **Step 2: Add view in App.tsx**

Add `activity` to `GlobalView`/`globalView` state. Render `<ActivityConsole ... />` when `globalView === 'activity'`. Add command palette entry and pass handlers to open project/thread.

- [ ] **Step 3: Build + commit**

Run build, then commit.

---

## Task 14: Frontend tests

**Files:**
- Create: `src/frontend/src/components/ActivityConsole.test.tsx`

- [ ] **Step 1: Write tests**

Test that running and recent rows render, row click opens detail panel, filters update, and abort/retry handlers are called.

- [ ] **Step 2: Run tests**

Run: `cd /Users/k-sym/Projects/nexus/.worktrees/activity-console && npm test -w @nexus/frontend -- ActivityConsole.test.tsx 2>&1 | tail -40`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
git add src/frontend/src/components/ActivityConsole.test.tsx
git commit -m "test: ActivityConsole UI"
```

---

## Task 15: Full verification

- [ ] **Step 1: Run backend test suite**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
npm test -w @nexus/backend 2>&1 | tail -30
```
Expected: all pass.

- [ ] **Step 2: Run frontend test suite**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
npm test -w @nexus/frontend 2>&1 | tail -30
```
Expected: all pass.

- [ ] **Step 3: Lint/typecheck**

```bash
cd /Users/k-sym/Projects/nexus/.worktrees/activity-console
npm run build 2>&1 | tail -30
```
Expected: successful build.

- [ ] **Step 4: Final commit and finish branch**

Use `superpowers:finishing-a-development-branch` to present merge options.
