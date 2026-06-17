# Activity Console Design

## Context

Nexus already has Mission Control as a dashboard, but it only surfaces a thin activity feed. Task work now runs inside chat threads, so the legacy `agent_runs` table no longer reflects live work. We need a single operational view where active and recent Nexus-controlled work can be inspected and acted on.

## Goals

- Show all currently running Nexus-controlled work in one place.
- Provide enough context per row to answer: what is running, why, where it came from, and what can be done about it.
- Keep a useful recent-history record for stopped/failed/completed work.
- Preserve Mission Control as the dashboard; this is the deeper operational view.
- Aggregate rather than replace existing task/session/status surfaces.

## Non-goals

- Replace Mission Control.
- Add a scheduler admin UI (there is no scheduler subsystem today).
- Expose per-job memory daemon indexing rows until the daemon exposes individual jobs.

## Decisions made during brainstorming

- Layout: dense table with a right-hand detail panel. Row click opens detail.
- Refresh cadence: reuse the existing 15-second poll used by Mission Control.
- Persistence: new SQLite `operations` table plus in-memory running set.
- Coupling: in-process event bus so producers stay decoupled from persistence.
- First-version controls:
  - Abort: active chat turns and Assistant streams.
  - Retry: failed memory archive and Jira/GitHub sync.
  - Open: navigate to project/thread/Assistant view.
  - Copy diagnostics: all operation kinds.
- Memory indexing: reserved `kind` but not implemented; aggregate daemon health stays in Mission Control.

## Architecture

```
┌─────────────────┐  start/update/stop   ┌──────────────────┐
│ Chat route      │─────────────────────▶│                  │
│ Assistant route │                      │  ActivityManager │
│ Jira/GitHub sync│─────────────────────▶│  - event bus     │
│ Memory archive  │                      │  - SQLite writes │
└─────────────────┘                      │  - running set   │
                                         └────────┬─────────┘
                                                  │ 15s poll
                                                  ▼
                                          ┌───────────────┐
                                          │ GET /api/activity
                                          │ POST /:id/abort
                                          │ POST /:id/retry
                                          │ GET  /:id/diagnostics
                                          └───────────────┘
```

Subsystems emit lifecycle events through `fastify.activity`. `ActivityManager` subscribes, persists rows, and maintains the in-memory running set. Existing routes and APIs remain unchanged.

## Data model

New table: `operations`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `kind` | TEXT | `chat_turn`, `assistant_stream`, `jira_sync`, `github_sync`, `memory_archive`. `memory_index` reserved. |
| `status` | TEXT | `running`, `succeeded`, `failed`, `cancelled` |
| `title` | TEXT | Human-readable summary |
| `project_id` | TEXT nullable | Link to project |
| `task_id` | TEXT nullable | Link to task |
| `thread_id` | TEXT nullable | Link to chat thread |
| `provider` | TEXT nullable | e.g. `anthropic` |
| `model` | TEXT nullable | e.g. `claude-sonnet-4` |
| `started_at` | TEXT | ISO timestamp |
| `completed_at` | TEXT nullable | ISO timestamp |
| `duration_ms` | INTEGER default 0 | Wall-clock duration |
| `usage_json` | TEXT nullable | `{ tokens?, contextWindow?, percent? }` |
| `last_event` | TEXT nullable | Latest activity label |
| `error` | TEXT nullable | Final or latest error message |
| `diagnostics_json` | TEXT nullable | Provider/stream details |

Indexes:
- `idx_operations_status`
- `idx_operations_kind`
- `idx_operations_started_at`
- `idx_operations_project_id`
- `idx_operations_thread_id`

## API

### `GET /api/activity?status=&kind=&limit=50`

Returns:

```json
{
  "running": [ ... ],
  "recent": [ ... ],
  "counts": { "running": 2, "succeeded": 4, "failed": 1, "cancelled": 0 }
}
```

`running` items include live `duration_ms` calculated from the in-memory running set. `recent` is the newest completed/cancelled rows up to `limit`.

### `GET /api/activity/:id`

Single operation, including `diagnostics_json`.

### `POST /api/activity/:id/abort`

Allowed for `chat_turn` and `assistant_stream` only. Delegates to existing abort routes. Returns `{ ok: true }` or `409` if not applicable.

### `POST /api/activity/:id/retry`

Allowed for `memory_archive`, `jira_sync`, and `github_sync`. Delegates to the existing archive or sync routes. On retry, a new `operations` row is started.

### `GET /api/activity/:id/diagnostics`

Returns `{ diagnostics?: object, lastEvent?: string, error?: string }`. Useful for copying or support.

## UI

- New global view: **Activity Console** in the top nav and command palette.
- Dense table with columns: Kind, What/Where, Status, Provider/Model, Time, Actions.
- Click a row to open the right-hand detail panel.
- Filters above the table: kind, status, and a search box over title/links.
- Detail panel repeats links, provider/model, timing, context usage, last event, error, and action buttons.
- Status colors: running green, succeeded blue, failed red, cancelled amber.

## Event producers

### Chat turn (`chat_turn`)
- `start` when the user turn begins.
- `update` on context usage events and notable pi events.
- `stop` with `succeeded`, `failed`, or `cancelled` when the stream ends.

### Assistant stream (`assistant_stream`)
- `start` when the assistant endpoint receives a message.
- `update` on text deltas or errors.
- `stop` when the stream closes.

### Jira sync (`jira_sync`) and GitHub sync (`github_sync`)
- `start` before the sync call.
- `stop` with `succeeded` or `failed` and a summary of inserted/updated/removed.

### Memory archive (`memory_archive`)
- `start` when `/api/threads/:id/archive` begins.
- `stop` with `succeeded` (memory id) or `failed` (error).

## Error handling

- Event bus handlers never throw back to producers.
- Startup sweep marks stale `running` rows as `cancelled` with a restart note.
- Unsupported actions return HTTP 409.
- Diagnostics endpoint always returns a payload even if diagnostics are empty.

## Testing

- Unit tests for `ActivityManager`: event handling, persistence, startup sweep, action validation.
- Route tests for `/api/activity` aggregation and action endpoints.
- Frontend tests for `ActivityConsole`: rendering, row selection, filters, action dispatch.
- Smoke test: start a chat turn, observe a running row, abort it, observe `cancelled`.

## Migration

Add the `operations` table and indexes in `src/backend/db.ts`. No existing tables are changed.

## Open questions / follow-ups

- `memory_index`: implement when the memory daemon exposes per-job progress.
- `chat_turn` retry: not included in the first version; can be added by re-posting the last user message.
- Live updates: 15s poll is the first version; SSE can be layered later without changing the data model.
