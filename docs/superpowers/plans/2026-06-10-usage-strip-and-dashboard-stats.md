# Usage Page Strip-Out and Dashboard Stats Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop tracking tokens in our database, delete the Usage page and its nav surface, and add three placeholder stats cards on the dashboard ready for a future codexbar integration.

**Architecture:** Two atomic commits. The first drops every token-tracking surface from the backend (DB columns, route, orchestrator writes, recent-activity query) and the frontend's dedicated Usage page + nav. The second adds the three dashboard stats cards, driven by a TDD test. Recent activity keeps run history but loses the per-row token suffix.

**Tech Stack:** Node 20+, TypeScript, Fastify, better-sqlite3 (SQLite 3.35+), React, vitest, @testing-library/react.

**Branch:** `feat/usage-strip-and-dashboard-stats`. Cut from the current `main` working tree (which has the prior dashboard-curation and active-provider-filter work uncommitted; that work becomes the first commit on the new branch).

---

## File structure

**Modify (backend):**
- `src/backend/db.ts` — drop token columns from CREATE TABLE, drop ALTER migrations, update recreate-table migration, add DROP COLUMN migrations for existing DBs.
- `src/backend/orchestrator/index.ts` — `completeAgentRun` stops writing token columns.
- `src/backend/routes/orchestrator.ts` — delete `/api/agents/usage`.
- `src/backend/routes/status.ts` — drop `ar.total_tokens` from the recent activity query.

**Delete (backend):**
- `src/backend/test/routes-orchestrator-usage.test.ts` — no longer needed.

**Modify (frontend):**
- `src/frontend/src/components/TopBar.tsx` — drop `'usage'` from `GlobalView`; drop the Usage button; drop unused `ChartBar` import.
- `src/frontend/src/App.tsx` — drop `UsagePage` import; drop `'usage'` from `GlobalView`; drop `view-usage` palette entry; drop the render branch.
- `src/frontend/src/api.ts` — drop `api.agents.usage`.
- `src/frontend/src/components/MissionControl.tsx` — drop `r.total_tokens` suffix from recent rows; drop `fmtTokens`; add three Stats cards.

**Delete (frontend):**
- `src/frontend/src/components/UsagePage.tsx`.

**Create (frontend test):**
- `src/frontend/src/components/MissionControl.test.tsx` — asserts the three stats cards render and the Recent activity list has no Tokens column / suffix.

---

## Task 1: Cut the feature branch and commit prior work

**Files:** none modified in this task — just git operations.

- [ ] **Step 1: Create and switch to the new branch**

```bash
git checkout -b feat/usage-strip-and-dashboard-stats
```

Expected: `Switched to a new branch 'feat/usage-strip-and-dashboard-stats'`.

- [ ] **Step 2: Stage the prior session's work**

```bash
git add src/backend/pi/oauth-curation-backfill.ts \
        src/backend/routes/auth.ts \
        src/backend/routes/orchestrator.ts \
        src/backend/routes/pi.ts \
        src/backend/routes/status.ts \
        src/frontend/src/components/MissionControl.tsx \
        src/backend/test/routes-orchestrator-usage.test.ts
```

Expected: all 7 files staged, no diffs left unstaged except the just-amended spec.

- [ ] **Step 3: Commit the prior work**

```bash
git commit -m "feat: dashboard curation filter + usage stats by active providers"
```

Expected: one commit, working tree shows only the spec edit (M docs/superpowers/specs/...).

- [ ] **Step 4: Amend the spec with the Tokens-column correction**

The spec was just edited to say "single-line flex layout" instead of "Tokens column". Add it to the prior commit so the spec history is clean:

```bash
git add docs/superpowers/specs/2026-06-10-usage-page-strip-and-dashboard-cards-design.md
git commit --amend --no-edit
```

Expected: working tree clean, one commit on the new branch.

- [ ] **Step 5: Verify baseline tests still pass**

```bash
npm run typecheck
npm --workspace=src/backend test
npm --workspace=src/frontend test
```

Expected: typecheck clean. Backend: 66 tests pass. Frontend: 44 tests pass. If anything fails, STOP and fix before proceeding.

---

## Task 2: Delete the orchestrator-usage test file

**Files:**
- Delete: `src/backend/test/routes-orchestrator-usage.test.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/backend/test/routes-orchestrator-usage.test.ts
```

- [ ] **Step 2: Verify backend tests pass with the file gone**

```bash
npm --workspace=src/backend test
```

Expected: 64 tests pass (was 66, minus the 2 from this file). The test runner auto-discovers `test/*.test.ts`, so removing the file removes the tests.

- [ ] **Step 3: Commit the test deletion**

This is a tiny change so it rides in a later commit. Leave it unstaged for now.

---

## Task 3: Update `db.ts` to drop the three token columns

**Files:**
- Modify: `src/backend/db.ts`

The current `CREATE TABLE agent_runs` block (around lines 82-98) includes `prompt_tokens`, `completion_tokens`, `total_tokens` columns. Remove them. Also remove the three corresponding entries from `runMigrations` (around lines 156-163) and add new `ALTER TABLE agent_runs DROP COLUMN` entries to handle existing DBs.

- [ ] **Step 1: Remove token columns from the CREATE TABLE block**

In `src/backend/db.ts`, replace lines 82-98:

```ts
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT,
      source TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL,
      output TEXT DEFAULT '',
      error TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
```

with:

```ts
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT,
      source TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL,
      output TEXT DEFAULT '',
      error TEXT,
      provider TEXT,
      model TEXT,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
```

- [ ] **Step 2: Replace the runMigrations entries**

In `src/backend/db.ts`, replace the `runMigrations` array (around lines 156-163):

```ts
  const runMigrations: Array<[string, string]> = [
    ['provider', 'ALTER TABLE agent_runs ADD COLUMN provider TEXT'],
    ['model', 'ALTER TABLE agent_runs ADD COLUMN model TEXT'],
    ['prompt_tokens', 'ALTER TABLE agent_runs ADD COLUMN prompt_tokens INTEGER DEFAULT 0'],
    ['completion_tokens', 'ALTER TABLE agent_runs ADD COLUMN completion_tokens INTEGER DEFAULT 0'],
    ['total_tokens', 'ALTER TABLE agent_runs ADD COLUMN total_tokens INTEGER DEFAULT 0'],
    ['duration_ms', 'ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER DEFAULT 0'],
  ];
```

with:

```ts
  const runMigrations: Array<[string, string]> = [
    ['provider', 'ALTER TABLE agent_runs ADD COLUMN provider TEXT'],
    ['model', 'ALTER TABLE agent_runs ADD COLUMN model TEXT'],
    ['duration_ms', 'ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER DEFAULT 0'],
  ];
  // Existing DBs created before the token-tracking strip may still have
  // these columns. Drop them now so the schema matches the CREATE TABLE
  // above. SQLite 3.35+ (bundled in better-sqlite3@^12) supports DROP COLUMN.
  const tokenColumnsToDrop = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  for (const col of tokenColumnsToDrop) {
    if (runColNames.has(col)) {
      db.exec(`ALTER TABLE agent_runs DROP COLUMN ${col}`);
    }
  }
```

- [ ] **Step 3: Update the recreate-table migration block**

In `src/backend/db.ts`, the recreate-table block (around lines 174-205) is triggered when the `source` column is missing. The `agent_runs_new` definition and the `INSERT INTO agent_runs_new (...) SELECT ... FROM agent_runs` must not reference the three token columns. Replace lines 177-200:

```ts
      db.exec(`
        CREATE TABLE agent_runs_new (
          id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          project_id TEXT,
          source TEXT NOT NULL DEFAULT 'task',
          status TEXT NOT NULL,
          output TEXT DEFAULT '',
          error TEXT,
          provider TEXT,
          model TEXT,
          prompt_tokens INTEGER DEFAULT 0,
          completion_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          duration_ms INTEGER DEFAULT 0,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO agent_runs_new (id, task_id, status, output, error, provider, model, prompt_tokens, completion_tokens, total_tokens, duration_ms, started_at, completed_at)
          SELECT id, task_id, status, output, error, provider, model, prompt_tokens, completion_tokens, total_tokens, duration_ms, started_at, completed_at FROM agent_runs;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_new RENAME TO agent_runs;
        UPDATE agent_runs SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = agent_runs.task_id) WHERE task_id IS NOT NULL;
      `);
```

with:

```ts
      db.exec(`
        CREATE TABLE agent_runs_new (
          id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          project_id TEXT,
          source TEXT NOT NULL DEFAULT 'task',
          status TEXT NOT NULL,
          output TEXT DEFAULT '',
          error TEXT,
          provider TEXT,
          model TEXT,
          duration_ms INTEGER DEFAULT 0,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO agent_runs_new (id, task_id, status, output, error, provider, model, duration_ms, started_at, completed_at)
          SELECT id, task_id, status, output, error, provider, model, duration_ms, started_at, completed_at FROM agent_runs;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_new RENAME TO agent_runs;
        UPDATE agent_runs SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = agent_runs.task_id) WHERE task_id IS NOT NULL;
      `);
```

- [ ] **Step 4: Verify backend typecheck and tests still pass**

```bash
npm run --workspace=src/backend typecheck
npm --workspace=src/backend test
```

Expected: typecheck clean. 64 tests pass. The existing `pi-model-curation.test.ts`, `pi-runtime.test.ts`, and `routes-chat.test.ts` don't touch the dropped columns.

---

## Task 4: Drop token writes from `completeAgentRun`

**Files:**
- Modify: `src/backend/orchestrator/index.ts:completeAgentRun` (around lines 232-260)

- [ ] **Step 1: Remove the three token columns from the UPDATE statement**

In `src/backend/orchestrator/index.ts`, replace lines 232-260:

```ts
function completeAgentRun(
  db: Database.Database,
  runId: string,
  status: string,
  output: string,
  error: string | undefined,
  meta: { provider: string; model: string; durationMs: number },
) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_runs SET
       status = ?, output = ?, error = ?, completed_at = ?,
       provider = ?, model = ?,
       prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, duration_ms = ?
     WHERE id = ?`,
  ).run(
    status,
    output.slice(0, 50000),
    error || null,
    now,
    meta.provider || null,
    meta.model || null,
    0,
    0,
    0,
    meta.durationMs || 0,
    runId,
  );
}
```

with:

```ts
function completeAgentRun(
  db: Database.Database,
  runId: string,
  status: string,
  output: string,
  error: string | undefined,
  meta: { provider: string; model: string; durationMs: number },
) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_runs SET
       status = ?, output = ?, error = ?, completed_at = ?,
       provider = ?, model = ?,
       duration_ms = ?
     WHERE id = ?`,
  ).run(
    status,
    output.slice(0, 50000),
    error || null,
    now,
    meta.provider || null,
    meta.model || null,
    meta.durationMs || 0,
    runId,
  );
}
```

- [ ] **Step 2: Verify backend typecheck and tests**

```bash
npm run --workspace=src/backend typecheck
npm --workspace=src/backend test
```

Expected: typecheck clean. 64 tests pass.

---

## Task 5: Delete the `/api/agents/usage` route

**Files:**
- Modify: `src/backend/routes/orchestrator.ts` (around lines 66-122)

- [ ] **Step 1: Replace the usage route with nothing**

In `src/backend/routes/orchestrator.ts`, replace lines 66-122 (the `// Aggregate token usage stats` block, the `// Scope to a project across BOTH chat runs` comment, and the entire `fastify.get('/api/agents/usage', ...)` body):

```ts
  // Aggregate token usage stats, optionally scoped to a project.
  fastify.get('/api/agents/usage', async (request) => {
    const { projectId } = request.query as { projectId?: string };

    // "Active" providers are those with credentials configured in
    // pi's AuthStorage right now. Historical runs for providers whose
    // auth has since been removed (or were never ours, e.g. legacy
    // build artifacts) are dropped from both totals and the breakdown
    // so they don't keep showing up after a logout.
    const activeProviders = fastify.pi.auth.list();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      conditions.push('(ar.project_id = ? OR ar.task_id IN (SELECT id FROM tasks WHERE project_id = ?))');
      params.push(projectId, projectId);
    }
    if (activeProviders.length > 0) {
      conditions.push(`ar.provider IN (${activeProviders.map(() => '?').join(',')})`);
      params.push(...activeProviders);
    } else {
      // No active providers → no usage. Keeps totals and the breakdown
      // consistent (zeros, not the full historical archive).
      conditions.push('1 = 0');
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totals = db.prepare(
      `SELECT
         COUNT(*) as runs,
         COALESCE(SUM(ar.prompt_tokens), 0) as prompt_tokens,
         COALESCE(SUM(ar.completion_tokens), 0) as completion_tokens,
         COALESCE(SUM(ar.total_tokens), 0) as total_tokens,
         COALESCE(SUM(ar.duration_ms), 0) as duration_ms
       FROM agent_runs ar ${whereSql}`
    ).get(...params) as any;

    const byProvider = db.prepare(
      `SELECT
         ar.provider,
         COUNT(*) as runs,
         COALESCE(SUM(ar.total_tokens), 0) as total_tokens
       FROM agent_runs ar
       WHERE ar.provider IS NOT NULL${conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''}
       GROUP BY ar.provider
       ORDER BY total_tokens DESC`
    ).all(...params);

    return { totals, byProvider };
  });
}
```

with:

```ts
}
```

(Just the closing `}` of `registerOrchestratorRoutes`.)

- [ ] **Step 2: Verify backend typecheck**

```bash
npm run --workspace=src/backend typecheck
```

Expected: clean. The `db` parameter and `fastify` parameter become unused, but TypeScript won't complain about unused function parameters by default. The `FastifyInstance` import is still used by the other route and the function signature.

- [ ] **Step 3: Verify backend tests**

```bash
npm --workspace=src/backend test
```

Expected: 64 tests pass. The deleted test file is no longer in the test count.

---

## Task 6: Drop `ar.total_tokens` from the recent activity query

**Files:**
- Modify: `src/backend/routes/status.ts` (around lines 16-25)

- [ ] **Step 1: Remove the `ar.total_tokens` column from the recent SELECT**

In `src/backend/routes/status.ts`, replace lines 15-25:

```ts
    const recent = db
      .prepare(
        `SELECT ar.id, ar.task_id, t.title as task_title, ar.status,
                ar.provider, ar.model,
                ar.prompt_tokens, ar.completion_tokens, ar.total_tokens, ar.duration_ms,
                ar.started_at, ar.completed_at
         FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id
         ORDER BY ar.started_at DESC LIMIT 10`,
      )
      .all();
```

with:

```ts
    const recent = db
      .prepare(
        `SELECT ar.id, ar.task_id, t.title as task_title, ar.status,
                ar.provider, ar.model, ar.duration_ms,
                ar.started_at, ar.completed_at
         FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id
         ORDER BY ar.started_at DESC LIMIT 10`,
      )
      .all();
```

- [ ] **Step 2: Verify backend tests + typecheck**

```bash
npm run --workspace=src/backend typecheck
npm --workspace=src/backend test
```

Expected: 64 tests pass. No test inspects `ar.total_tokens` in the recent activity result.

---

## Task 7: Backend verification + commit

**Files:** none new — commit the staged work.

- [ ] **Step 1: Stage backend changes**

```bash
git add -A src/backend
```

Expected: stages `db.ts`, `orchestrator/index.ts`, `routes/orchestrator.ts`, `routes/status.ts`, and the deleted test file.

- [ ] **Step 2: Verify the diff is what you expect**

```bash
git diff --cached --stat
```

Expected:
```
 src/backend/db.ts                          | ...
 src/backend/orchestrator/index.ts          | ...
 src/backend/routes/orchestrator.ts          | ...
 src/backend/routes/status.ts                | ...
 src/backend/test/routes-orchestrator-usage.test.ts | -100+ lines (deletion)
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: drop token tracking and /api/agents/usage"
```

Expected: one commit on the new branch.

- [ ] **Step 4: Full backend verification**

```bash
npm run --workspace=src/backend typecheck
npm --workspace=src/backend test
```

Expected: clean. 64 tests pass.

---

## Task 8: Delete `UsagePage.tsx` and remove all references

**Files:**
- Delete: `src/frontend/src/components/UsagePage.tsx`
- Modify: `src/frontend/src/components/TopBar.tsx`
- Modify: `src/frontend/src/App.tsx`
- Modify: `src/frontend/src/api.ts`

- [ ] **Step 1: Delete the component file**

```bash
rm src/frontend/src/components/UsagePage.tsx
```

- [ ] **Step 2: Update `TopBar.tsx`**

Replace the entire file content. The current file is 48 lines. New content:

```tsx
import { Gauge, Ticket, Gear } from '@phosphor-icons/react';

export type GlobalView = 'dashboard' | 'tickets';
export type ManageView = 'settings';

interface TopBarProps {
  view: string;
  onSelectGlobal: (v: GlobalView) => void;
  onSelectManage: (v: ManageView) => void;
  onOpenPalette: () => void;
}

const item = (active: boolean) =>
  `shrink-0 flex items-center gap-1.5 px-3 py-1 text-sm rounded-md transition-colors whitespace-nowrap ${
    active ? 'surface-active accent-text' : 'text-muted hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
  }`;

export default function TopBar({ view, onSelectGlobal, onSelectManage, onOpenPalette }: TopBarProps) {
  // The Electron window hides the native title bar (titleBarStyle: hiddenInset),
  // so the TopBar doubles as the drag handle; on macOS it also has to clear the
  // traffic-light buttons drawn over the top-left. Browser ("web") mode has
  // neither, so gate on the Electron user-agent.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isElectron = /Electron/i.test(ua);
  const isMac = /Mac/i.test(ua);
  const chrome = `${isElectron ? ' titlebar-drag' : ''}${isElectron && isMac ? ' mac-traffic-lights' : ''}`;

  return (
    <header className={`h-12 shrink-0 flex items-center gap-1.5 px-3 border-b border-subtle surface-glass${chrome}`}>
      <div className="flex items-center gap-2 pr-1">
        <div className="w-6 h-6 rounded accent-button flex items-center justify-center text-[11px] font-bold">N</div>
        <span className="font-semibold text-sm tracking-wide hidden md:inline">NEXUS</span>
      </div>
      <button onClick={onOpenPalette} title="Command palette" className="shrink-0 px-2 py-1 text-xs text-faint hover:text-[var(--text-primary)] border border-subtle rounded-md hover:border-[var(--border-strong)] transition-colors">⌘K</button>
      <div className="w-px h-5 bg-[var(--border-subtle)] mx-1 shrink-0" />

      {/* Global / cross-project links */}
      <button onClick={() => onSelectGlobal('dashboard')} className={item(view === 'dashboard')}><Gauge size={16} weight={view === 'dashboard' ? 'fill' : 'regular'} /> Dashboard</button>
      <button onClick={() => onSelectGlobal('tickets')} className={item(view === 'tickets')}><Ticket size={16} weight={view === 'tickets' ? 'fill' : 'regular'} /> Tickets</button>

      {/* Management group, right-aligned */}
      <div className="ml-auto flex items-center gap-1.5">
        <button onClick={() => onSelectManage('settings')} className={item(view === 'settings')}><Gear size={16} /> Settings</button>
      </div>
    </header>
  );
}
```

Diffs vs the current file: removed `ChartBar` from the icon import; removed `'usage'` from `GlobalView`; removed the Usage button row.

- [ ] **Step 3: Update `App.tsx`**

Three edits:

3a. Remove the UsagePage import (line 15):

Replace:
```tsx
import UsagePage from './components/UsagePage';
```
with: (delete the line)

3b. Remove `'usage'` from the `GlobalView` type (line 21):

Replace:
```tsx
type GlobalView = 'dashboard' | 'tickets' | 'usage' | 'settings';
```
with:
```tsx
type GlobalView = 'dashboard' | 'tickets' | 'settings';
```

3c. Remove the `view-usage` palette entry (line 248):

Replace:
```tsx
      { id: 'view-tickets', label: 'Tickets', hint: 'View', run: () => selectGlobal('tickets') },
      { id: 'view-usage', label: 'Usage', hint: 'View', keywords: 'tokens', run: () => selectGlobal('usage') },
    ];
```
with:
```tsx
      { id: 'view-tickets', label: 'Tickets', hint: 'View', run: () => selectGlobal('tickets') },
    ];
```

3d. Remove the render branch (line 271):

Replace:
```tsx
    if (globalView === 'tickets')
      return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;
    if (globalView === 'usage') return <UsagePage projectId={activeProjectId ?? undefined} />;

    if (!activeProject) {
```
with:
```tsx
    if (globalView === 'tickets')
      return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;

    if (!activeProject) {
```

- [ ] **Step 4: Update `api.ts`**

Find the `agents` block. It currently has a `usage` entry. Remove the `usage` line:

Replace:
```ts
    usage: (projectId?: string) => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      return fetchJson<any>(`/api/agents/usage${qs}`);
    },
    status: () => fetchJson<{ running: any[]; recent: any[] }>(`/api/agents/status`),
```
with:
```ts
    status: () => fetchJson<{ running: any[]; recent: any[] }>(`/api/agents/status`),
```

(The exact surrounding lines may differ — locate `usage:` inside the `agents` namespace and remove the line including the trailing comma so the next line is the new last entry.)

- [ ] **Step 5: Verify frontend typecheck**

```bash
npm run --workspace=src/frontend typecheck
```

Expected: clean.

---

## Task 9: Add the MissionControl stats cards test (TDD, write failing test first)

**Files:**
- Create: `src/frontend/src/components/MissionControl.test.tsx`

- [ ] **Step 1: Create the test file**

Write the following to `src/frontend/src/components/MissionControl.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MissionControl from './MissionControl';

const status = {
  memory: { ok: true, memories: 0, jobs: { pending: 0, dead: 0 }, models: { gen: true, embed: true, rerank: true } },
  models: [],
  activity: { running: [], recent: [] },
};

describe('MissionControl', () => {
  it('renders the three stats cards as placeholders', () => {
    render(
      <MissionControl
        status={status as any}
        loading={false}
        onRefresh={() => {}}
        onSelectAgent={() => {}}
      />,
    );
    expect(screen.getByText('Claude Stats')).toBeInTheDocument();
    expect(screen.getByText('Codex Stats')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter Stats')).toBeInTheDocument();
    expect(screen.getByText('codexbar session · 5h rolling')).toBeInTheDocument();
    expect(screen.getByText('codexbar session · weekly')).toBeInTheDocument();
    expect(screen.getByText('codexbar credit balance')).toBeInTheDocument();
  });

  it('does not show token data in the recent activity rows', () => {
    render(
      <MissionControl
        status={{
          ...status,
          activity: {
            running: [],
            recent: [
              { id: '1', task_title: 'Sample task', provider: 'anthropic', model: 'sonnet', status: 'completed', duration_ms: 1234 },
            ],
          },
        } as any}
        loading={false}
        onRefresh={() => {}}
        onSelectAgent={() => {}}
      />,
    );
    expect(screen.getByText('Sample task')).toBeInTheDocument();
    expect(screen.queryByText(/tok/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npm --workspace=src/frontend test -- src/components/MissionControl.test.tsx
```

Expected: FAIL. The three stats cards don't exist yet, so `getByText('Claude Stats')` etc. throw. The "does not show token data" test will pass by accident because no `tok` substring exists in the current code — that's fine, the first test fails and that's the failure signal.

---

## Task 10: Update `MissionControl.tsx` to add the stats cards and drop the token suffix

**Files:**
- Modify: `src/frontend/src/components/MissionControl.tsx`

- [ ] **Step 1: Add the Stats section between the Models grid and Recent activity**

After the closing `</div>` of the Models grid section (currently ends around line 127) and before the `{/* Recent activity */}` comment (line 129), insert the new Stats section.

In the current file, the relevant lines are:

```tsx
          {/* Agent roster — now a model list. Each row shows provider,
              id, and whether auth is configured. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-2">Models</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(status.models ?? []).map((m) => (
                <ModelCard key={`${m.provider}/${m.id}`} m={m} onClick={() => onSelectAgent(m.id)} />
              ))}
              {(status.models ?? []).length === 0 && <div className="text-sm text-faint">No models available.</div>}
            </div>
          </div>

          {/* Recent activity */}
```

Replace the entire block above with:

```tsx
          {/* Agent roster — now a model list. Each row shows provider,
              id, and whether auth is configured. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-2">Models</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(status.models ?? []).map((m) => (
                <ModelCard key={`${m.provider}/${m.id}`} m={m} onClick={() => onSelectAgent(m.id)} />
              ))}
              {(status.models ?? []).length === 0 && <div className="text-sm text-faint">No models available.</div>}
            </div>
          </div>

          {/* Stats — placeholder cards. Populated by the future codexbar
              integration (Claude/Codex session-remaining + OpenRouter
              credit balance). For now each card shows an em-dash. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-2">Stats</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Card title="Claude Stats">
                <div className="text-2xl font-semibold text-faint">—</div>
                <div className="text-xs text-muted mt-1">codexbar session · 5h rolling</div>
              </Card>
              <Card title="Codex Stats">
                <div className="text-2xl font-semibold text-faint">—</div>
                <div className="text-xs text-muted mt-1">codexbar session · weekly</div>
              </Card>
              <Card title="OpenRouter Stats">
                <div className="text-2xl font-semibold text-faint">—</div>
                <div className="text-xs text-muted mt-1">codexbar credit balance</div>
              </Card>
            </div>
          </div>

          {/* Recent activity */}
```

- [ ] **Step 2: Remove the `r.total_tokens` suffix from the recent activity rows**

Find this block (around lines 142-150 in the current file):

```tsx
              {status.activity.recent.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted truncate">{r.task_title}</span>
                  <span className="text-xs text-faint shrink-0">
                    {r.provider} · {r.status}
                    {r.total_tokens ? ` · ${r.total_tokens} tok` : ''}
                  </span>
                </div>
              ))}
```

Replace with:

```tsx
              {status.activity.recent.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted truncate">{r.task_title}</span>
                  <span className="text-xs text-faint shrink-0">
                    {r.provider} · {r.status}
                  </span>
                </div>
              ))}
```

- [ ] **Step 3: Remove the now-unused `fmtTokens` function**

Find the `fmtTokens` function (around lines 9-13 in the current file):

```tsx
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

Delete the entire function (it has no other users — `fmtDuration` below it is still used by the Recent activity duration display and stays).

- [ ] **Step 4: Run the MissionControl test and confirm it passes**

```bash
npm --workspace=src/frontend test -- src/components/MissionControl.test.tsx
```

Expected: PASS, both tests green.

- [ ] **Step 5: Run the full frontend test suite**

```bash
npm --workspace=src/frontend test
```

Expected: 46 tests pass (44 prior + 2 new). The pre-existing `act(...)` warnings in `ChatPanel.test.tsx` are unrelated and remain.

---

## Task 11: Frontend verification + commit

**Files:** none new — commit the staged work.

- [ ] **Step 1: Stage frontend changes**

```bash
git add -A src/frontend
```

Expected: stages `TopBar.tsx`, `App.tsx`, `api.ts`, `MissionControl.tsx`, the new `MissionControl.test.tsx`, and the deleted `UsagePage.tsx`.

- [ ] **Step 2: Verify the diff is what you expect**

```bash
git diff --cached --stat
```

Expected:
```
 src/frontend/src/App.tsx                                  | ...
 src/frontend/src/api.ts                                   | ...
 src/frontend/src/components/MissionControl.test.tsx       | +new
 src/frontend/src/components/MissionControl.tsx            | ...
 src/frontend/src/components/TopBar.tsx                    | ...
 src/frontend/src/components/UsagePage.tsx                 | -deleted
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: remove Usage page, add dashboard Stats cards"
```

Expected: one commit on the new branch.

---

## Task 12: Full-stack final verification

**Files:** none — verification only.

- [ ] **Step 1: Full root typecheck**

```bash
npm run typecheck
```

Expected: all three workspaces (shared, backend, frontend) clean.

- [ ] **Step 2: Full backend test run**

```bash
npm --workspace=src/backend test
```

Expected: 64 tests pass.

- [ ] **Step 3: Full frontend test run**

```bash
npm --workspace=src/frontend test
```

Expected: 46 tests pass.

- [ ] **Step 4: Manual smoke checklist**

1. `npm --workspace=src/backend dev` and `npm --workspace=src/frontend dev` in two terminals.
2. Open the app in the browser. Verify:
   - Dashboard renders with the existing Memory and Models cards in the status strip.
   - Below the curated Models grid, a new "Stats" section appears with three cards: `Claude Stats`, `Codex Stats`, `OpenRouter Stats`.
   - Each stats card shows an em-dash and a one-line caption (`codexbar session · 5h rolling`, `codexbar session · weekly`, `codexbar credit balance`).
   - The Recent activity list (if any rows are present) shows `provider · status` with no ` · N tok` suffix.
3. Verify the TopBar has no `Usage` button (only `Dashboard`, `Tickets`, `Settings`).
4. Open the command palette (⌘K) and verify there is no `Usage` entry.
5. Hit `/api/agents/usage` directly in the browser — expect 404 (the route is gone).
6. `cat ~/.nexus/nexus.db | sqlite3 :memory: 'PRAGMA table_info(agent_runs)'` — verify the three token columns are absent.
   - If a pre-existing DB was kept, you should see `prompt_tokens`, `completion_tokens`, `total_tokens` get dropped on startup (the new DROP COLUMN migration runs once). For a fresh DB the columns never exist.

- [ ] **Step 5: Final report**

Report back with:
- Branch name (`feat/usage-strip-and-dashboard-stats`)
- Number of commits (expected: 3 — prior-session work, backend strip, frontend strip + cards)
- Test counts (expected: backend 64, frontend 46)
- Anything that surprised you

---

## Self-review (run before handoff)

After writing the plan, I checked:

- **Spec coverage:** every spec section has a task. Backend drops → Tasks 2-7. Frontend drops → Task 8. Stats cards → Tasks 9-10. Verification → Tasks 11-12.
- **Placeholder scan:** no "TBD" / "TODO" / "similar to Task N" / vague steps. Every code change has the actual code.
- **Type consistency:** `completeAgentRun`'s `meta` argument shape is preserved across Tasks 4 and 7. The new Stats cards reuse the existing `Card` helper with the same props as Memory/Models.
- **Migration ordering:** DROP COLUMN is added in Task 3 BEFORE the route is deleted in Task 5, so any startup attempt that hits the DB doesn't blow up due to a stale `ar.total_tokens` reference.
