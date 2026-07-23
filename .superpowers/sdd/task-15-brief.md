# Task 15: Per-project Monday scope configuration

**Why this exists:** `MondayProjectConfig` is read by three backend modules but nothing ever writes it. Every project therefore returns 409 "no Monday scope configured", and the Project Management view renders an error with a Retry button that can never succeed. The feature is currently reachable only by hand-editing `projects.config_json` in SQLite. This task closes that.

**Where it lives:** the Project Management view itself. When a project has no scope configured, the view shows the configuration panel instead of an error. When it is configured, a "Configure" control reopens the panel. Configuring where you use it also removes the dead-end.

## What gets configured

`MondayProjectConfig` (already in `src/shared/index.ts`):

```ts
{
  board_id: string;
  group_id?: string | null;
  rollup: { enabled: boolean; column_id: string | null; column_type: 'text' | 'numeric' };
  updates: { enabled: boolean; min_interval_minutes: number };
}
```

`column_type` is **derived from the chosen column's Monday type at selection time** — never inferred from the column id. Monday column ids are user-renamable; that is precisely the bug this field exists to prevent.

## Files

**Modify:**
- `src/backend/monday/client.ts` — add `fetchBoards`, `fetchBoardMeta`
- `src/backend/routes/monday.ts` — add four endpoints
- `src/frontend/src/api.ts` — add the matching client functions
- `src/frontend/src/components/ProjectManagementView.tsx` — render the panel when unconfigured; add a Configure control when configured

**Create:**
- `src/frontend/src/components/MondayScopeSettings.tsx`
- `src/backend/test/monday-config-routes.test.ts`
- `src/frontend/src/components/MondayScopeSettings.test.tsx`

## Backend

### Client additions (`client.ts`)

Two read-only queries, following the existing query style and going through `mondayGraphql` so the 200-with-errors handling applies:

- `fetchBoards(opts)` → boards the token can see: `id`, `name`, and the workspace name where available. Exclude template/subitem boards if Monday exposes a distinguishing field; otherwise return all and let the user choose.
- `fetchBoardMeta(opts, boardId)` → for one board: its `groups { id title }` and `columns { id title type }`.

Both must not widen the write surface. This file still exposes exactly two mutations (`setSimpleColumnValue`, `createUpdate`) — do not add a third.

### Endpoints (`routes/monday.ts`)

Follow the file's existing conventions: `registerMondayRoutes(fastify)` reading the `fastify.db` decoration, 404 for an unknown project, 409 when Monday is disabled or tokenless, **502 when Monday itself fails**, carrying `{ error, code, retryable }`.

- `GET /api/monday/boards` → `{ boards: [{ id, name, workspace }] }` — live from Monday.
- `GET /api/monday/boards/:boardId/meta` → `{ groups: [{ id, title }], columns: [{ id, title, type }] }` — live from Monday.
- `GET /api/monday/projects/:projectId/config` → `{ config: MondayProjectConfig | null }` — reads `projects.config_json`.
- `PUT /api/monday/projects/:projectId/config` → body is a `MondayProjectConfig`; validates and persists.

**Validation on PUT (server-side, not only in the UI):**
- `board_id` required and non-empty → 400 otherwise.
- If `rollup.enabled` is true, `column_id` must be non-empty → 400 otherwise. A roll-up switched on with nowhere to write is the misconfiguration that later self-disables and notifies the user; reject it up front.
- `column_type` must be `'text'` or `'numeric'`.
- `updates.min_interval_minutes` must be a positive number; apply a sane floor so a user cannot set 0 and hammer Monday.
- Unknown keys in the `monday` block are dropped rather than persisted.

**The write must preserve every other key in `config_json`.** That blob also holds `column_defaults` and potentially future settings. Read, modify only the `monday` key, write back. A read-modify-write that clobbers a sibling key is the failure mode to avoid.

## Frontend

### `MondayScopeSettings.tsx`

Props: `{ projectId, current: MondayProjectConfig | null, onSaved: () => void, onCancel?: () => void }`.

Flow:
1. Load boards. While loading, say so; on failure show the error — never an empty picker that looks like "you have no boards".
2. On board selection, load that board's groups and columns.
3. Group is optional — offer an explicit "whole board" choice rather than leaving the control blank and ambiguous.
4. Roll-up: a toggle plus a column picker listing the board's columns. Show each column's Monday type so the choice is informed, and **set `column_type` from the selected column's type** (`numbers`/`numeric` → `'numeric'`, everything else → `'text'`). Disable the column picker when the toggle is off.
5. Updates: a toggle plus the interval, with the interval disabled when the toggle is off.
6. Save calls the PUT endpoint, then `onSaved()`.

State handling requirements, matching what the rest of this feature already does:
- A load or save failure renders as an error, **never** as an empty or apparently-successful state.
- Guard against a stale response overwriting newer data when the selected board changes while a metadata request is in flight — `ProjectManagementView` uses a monotonic generation counter for exactly this; follow that precedent rather than a per-effect boolean, since these loads are triggered by user interaction as well as mount.
- Disable Save while saving, and while required fields are missing.

### `ProjectManagementView.tsx`

- Distinguish "not configured" from other errors. The backend returns 409 with a distinguishable body for an unconfigured project; render `MondayScopeSettings` in that case instead of the error screen.
- When configured, add a Configure control in the header that reopens the panel.
- After a successful save, reload the view so items appear without a manual refresh.
- Do not regress: a load failure must never render as an empty board; a failed refresh keeps already-loaded items visible; the generation guard keeps working.

## Constraints

- The `MONDAY_TOKEN` environment variable remains the only token source. This panel must never offer a token field.
- The write invariant is unchanged: Nexus writes only the configured roll-up column and the updates feed.
- `column_type` comes from Monday's reported column type, never from the column id string.
- The new PUT is the validated path for Monday settings; do not route Monday config through the existing opaque `PUT /api/projects/:id` `config_json` passthrough.
- Backend tests must import `./support/nexus-test-dir` FIRST so they use a private tmpdir and never touch the developer's real `~/.nexus/config.yaml`.

## Testing

Backend: validation rejections (missing board, roll-up on with no column, bad `column_type`, non-positive interval); sibling keys in `config_json` survive a write; 404 unknown project; 409 when Monday is disabled or tokenless; 502 when Monday fails, asserting it is not reported as an empty list.

Frontend: board list renders; selecting a board loads groups and columns; `column_type` is derived from the selected column's type (assert both directions, with a column whose id and type disagree so an id-sniffing implementation would fail); save posts the expected payload; a load failure shows an error rather than an empty picker; an unconfigured project renders the panel rather than the error screen.
