# Usage Page Strip-Out and Dashboard Stats Cards Design

## Goal

Stop tracking tokens in our own database (let codexbar own that), remove the dedicated Usage page and its navigation surface, and surface three placeholder stats cards on the dashboard ready to be filled in by a future codexbar integration.

## Scope

- **Drop**: `prompt_tokens`, `completion_tokens`, `total_tokens` columns on `agent_runs`; the `/api/agents/usage` route; the `completeAgentRun` token writes; the Recent activity "Tokens" column; the `UsagePage` component; the TopBar Usage button; the command palette `view-usage` entry; the `api.agents.usage` client method; the `routes-orchestrator-usage.test.ts` test file.
- **Keep**: `agent_runs` table itself; the orchestrator's run-history writes; `/api/mission-control`; the Recent activity list; all run history (status, provider, model, duration, timestamps); the existing curated-models work.
- **Add**: a new "Stats" section on the dashboard with three placeholder cards (`Claude Stats`, `Codex Stats`, `OpenRouter Stats`).

## Architecture

### Backend

**`src/backend/db.ts`**
- Remove `prompt_tokens`, `completion_tokens`, `total_tokens` from the `CREATE TABLE agent_runs` block.
- Remove the three matching entries from `runMigrations`.
- Update the recreate-table migration block (lines ~177-200) so the `agent_runs_new` definition and the `INSERT INTO agent_runs_new (...) SELECT ... FROM agent_runs` statement no longer reference the three token columns. The `DROP TABLE` + `ALTER TABLE ... RENAME TO` pattern is otherwise unchanged.
- For existing DBs that already have the columns: add a one-time `ALTER TABLE agent_runs DROP COLUMN` per token column inside the `runMigrations` loop. The bundled SQLite (via `better-sqlite3@^12`) supports `DROP COLUMN` (3.35+). If a column is already absent the loop skips it, so the migration is idempotent.

**`src/backend/orchestrator/index.ts:completeAgentRun`**
- Drop the three token columns from the `UPDATE agent_runs SET ...` statement.
- The `meta` argument keeps `provider`, `model`, `durationMs`. No other call sites need changes; only the orchestrator writes to `agent_runs` after completion.

**`src/backend/routes/orchestrator.ts`**
- Delete the `/api/agents/usage` route and its `// Aggregate token usage stats` comment. `registerOrchestratorRoutes` retains `/api/agents/status` and the start route.

**`src/backend/routes/status.ts`**
- Drop `ar.total_tokens` from the `recent` activity query's `SELECT` list (lines ~16-24). Keep `ar.duration_ms`. Token totals will no longer be available to the frontend's Recent activity list.

**`src/backend/test/routes-orchestrator-usage.test.ts`**
- Delete the file.

### Frontend

**`src/frontend/src/components/UsagePage.tsx`**
- Delete the file.

**`src/frontend/src/components/TopBar.tsx`**
- Remove `'usage'` from the `GlobalView` type union.
- Remove the `<button>...Usage</button>` line.
- Remove the now-unused `ChartBar` import.

**`src/frontend/src/App.tsx`**
- Remove the `import UsagePage` line.
- Remove `'usage'` from the `GlobalView` type union.
- Remove the `view-usage` command palette entry.
- Remove the `if (globalView === 'usage') return <UsagePage ...>` branch from `renderMain`.

**`src/frontend/src/api.ts`**
- Remove the `usage: ...` entry from the `agents` namespace.

**`src/frontend/src/components/MissionControl.tsx`**
- New section between the Models grid and Recent activity, titled "Stats", containing a 3-column grid (matching the Models grid breakpoint: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`).
- Three cards, each using the existing `Card` helper:
  - **Claude Stats** — value `—`, caption `codexbar session · 5h rolling`. Once codexbar lands: session-remaining and reset window.
  - **Codex Stats** — value `—`, caption `codexbar session · weekly`. Once codexbar lands: session-remaining and reset window.
  - **OpenRouter Stats** — value `—`, caption `codexbar credit balance`. Once codexbar lands: credit balance in USD.
- Remove the ` · {r.total_tokens} tok` suffix from the recent activity rows (line ~147). MissionControl uses a single-line flex layout for the Recent activity list (not a grid), so there is no Tokens column header to remove — only the inline suffix. Remove the now-unused `fmtTokens` import / function.

### New tests

**`src/frontend/src/components/MissionControl.test.tsx`**
- Render `MissionControl` with a minimal status payload and assert:
  - All three stats cards render with their titles.
  - Each shows the em-dash placeholder value.
  - Each shows the appropriate caption.
  - The Recent activity grid does NOT include a "Tokens" column header.

## Data flow

Before: orchestrator writes token zeros to `agent_runs` → `/api/agents/usage` aggregates them → `UsagePage` renders the breakdown → Recent activity surfaces `total_tokens` per row.

After: orchestrator writes only run-history fields to `agent_runs` → `/api/mission-control` returns recent activity (no tokens) → `MissionControl` shows Memory / Models status strip, the curated Models grid, three stats cards (placeholders), and the Recent activity list (no Tokens column). No route or endpoint surfaces token data anywhere; that responsibility is fully delegated to codexbar.

## Error handling

- `ALTER TABLE ... DROP COLUMN` on a column that doesn't exist will be a no-op (the existing `runColNames.has(col)` check).
- The drop will run on every startup if a token column is somehow still present. The migration loop's existence check prevents duplicate attempts.
- If SQLite ever fails the drop (e.g. an unhandled older-version case), startup fails loudly — correct dev signal.
- The MissionControl status fetch (`/api/mission-control`) is unchanged; removing the tokens from the recent query does not change its response shape beyond dropping the field.

## Testing

- `npm run typecheck` (root) must pass.
- `npm --workspace=src/backend test` must pass (the 64 existing tests, minus the two we delete).
- `npm --workspace=src/frontend test` must pass (the 44 existing tests, plus the new MissionControl stats cards test).
- A manual smoke: open the app, click Dashboard, verify the three stats cards appear, verify there is no TopBar "Usage" button, verify the command palette no longer offers "Usage".

## Out of scope (intentional)

- codexbar integration (session-remaining and credit balance wiring).
- Renaming `agent_runs` / `source` / `project_id` columns.
- Changes to the `chat_threads` / `chat_messages` schema.
- A different stats card layout or different provider list (the three names come from the user's explicit list).
