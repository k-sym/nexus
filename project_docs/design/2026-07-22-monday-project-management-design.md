# Monday.com integration — "Project Management" (design)

**Date:** 2026-07-22
**Status:** Design approved, not yet implemented
**Follow-on (separate spec):** standing session preamble that makes every agent aware of memory, Kanban, and Monday

---

## Problem

The Kanban board is the right granularity for issues and tasks. It is the wrong
granularity for initiatives. That higher level increasingly lives in Monday.com,
and today Nexus knows nothing about it: an agent working a task cannot see which
initiative the task serves, and someone reading Monday cannot see that four Nexus
tasks under an initiative are already in Review.

This spec connects the two levels: a Monday item is the initiative, Nexus tasks
are its children, and progress rolls up.

## Non-goals

Deliberately out of scope, listed so the plan does not quietly grow them:

- **Global portfolio view** (Monday items across all Nexus projects in one place).
  It is a read-only aggregation over exactly the data this spec produces, so it is
  cheap to add later and expensive to design against before the model has been used.
- **Item, subitem, or column creation from Nexus.** Agents read the portfolio; they
  do not restructure it. If item creation is wanted later it belongs in a Mission
  handler with the audit ledger, not a free-floating tool.
- **Webhooks.** Monday pushing to Nexus needs a publicly reachable endpoint, which a
  local-first app behind Tailscale does not have.
- **Status-column writes.** See the write invariant below.
- **The standing session preamble.** Separate spec; this one builds the hook it needs.

## Decisions

| Question | Decision |
|---|---|
| Relationship to Kanban | Two-way link at item level. Monday item = initiative, Nexus tasks = children. |
| Project → Monday binding | Configurable **scope** per project (board, optionally narrowed to a group). Degrades to unscoped linking when unset. |
| Link cardinality | **One Monday item per task**, many tasks per item. `task_id` is the primary key of the link table. |
| What Nexus writes | **Roll-up** to a configured column + a **throttled updates feed**. Both opt-in per project. Never the status column. |
| Agent capability | Read tools (`monday_search`, `monday_get_item`) + automatic context injection of the linked item. `monday_post_update` only when the project opts in. No writes beyond that. |
| Freshness | Lazy full-scope sync on view open; background refresh of **linked items only**; the link picker queries Monday live. |
| UI | Per-project item-centric view + a back-reference badge on Kanban cards. |

The cardinality decision has a known cost: a task serving two initiatives cannot
say so. Accepted in exchange for an unambiguous roll-up and a single-chip badge.

## Architecture

Module layout mirrors the existing `jira/` and `github/` integrations.

```
src/backend/monday/
  client.ts     # GraphQL client — auth, error mapping, complexity budget
  map.ts        # pure: Monday item → mirror row
  sync.ts       # scope sync + linked-item refresh → SQLite upsert
  poll.ts       # background refresh, linked items only
  rollup.ts     # pure: linked task states → roll-up value
  writes.ts     # column write + update post, throttled and coalesced
src/backend/routes/monday.ts    # /api/monday/*
src/backend/pi/monday-tool.ts   # agent tool extension
src/frontend/src/components/ProjectManagementView.tsx
```

### Data model

Two new tables, separate on purpose.

**`monday_items`** — a disposable mirror. Monday stays canonical, same contract as
`tickets`. Rebuildable at any time from the API.

```sql
CREATE TABLE IF NOT EXISTS monday_items (
  item_id            TEXT PRIMARY KEY,
  board_id           TEXT NOT NULL,
  board_name         TEXT NOT NULL DEFAULT '',
  group_id           TEXT,
  group_title        TEXT,
  name               TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT 'active',  -- active | archived | deleted | missing
  status_label       TEXT,
  status_color       TEXT,
  owners_json        TEXT NOT NULL DEFAULT '[]',
  url                TEXT,
  column_values_json TEXT NOT NULL DEFAULT '{}',
  monday_updated_at  TEXT,
  synced_at          TEXT NOT NULL
);
```

`column_values_json` is stored raw because context injection and the read tools
need fields this schema does not model.

**`task_monday_links`** — *not* disposable. This is user intent and must survive a
mirror wipe or a board reorganisation.

```sql
CREATE TABLE IF NOT EXISTS task_monday_links (
  task_id    TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Indexes (created **after** the tables, per the migration hazard noted below):

```sql
CREATE INDEX IF NOT EXISTS idx_monday_items_board ON monday_items(board_id);
CREATE INDEX IF NOT EXISTS idx_task_monday_links_item ON task_monday_links(item_id);
CREATE INDEX IF NOT EXISTS idx_task_monday_links_project ON task_monday_links(project_id);
```

The split is what makes "clear the Monday mirror" a safe maintenance action, which
is how it should appear in the existing trust-snapshot controls alongside the
memory-index rebuild.

### Configuration

**Per project** — no migration needed, `projects.config_json` already exists:

```json
{
  "monday": {
    "board_id": "1234567890",
    "group_id": "topics",
    "rollup":  { "enabled": true,  "column_id": "text_mkxyz", "column_type": "text" },
    "updates": { "enabled": false, "min_interval_minutes": 30 }
  }
}
```

**Global** — `~/.nexus/config.yaml`, alongside `jira:` and `github:`:

```yaml
monday:
  enabled: false
  api_version: "2026-07"
  poll_minutes: 10
```

`api_version` is pinned deliberately — Monday dates its API and an unpinned client
shifts under you. Confirmed during implementation (2026-07-22): `2024-10` was
deprecated on 2026-02-15, and deprecated versions are silently routed to a
maintenance version rather than rejected — so an unnoticed stale pin fails
invisibly. Current window is 2026-04 (Maintenance) / 2026-07 (Current) /
2026-10 (RC); we pin `2026-07`.

**Token** — `MONDAY_TOKEN` environment variable only. Never config, never the DB.
Same rule as `JIRA_TOKEN`, and it must be reflected in the trust snapshot's secret
sources.

## Data flow

### Read

Three paths, each matched to a different freshness requirement.

1. **Scope sync** — lazy, on Project Management view open and on manual refresh.
   Paginated `items_page` over the scoped board (cursor-based), upserted into the
   mirror. Pruning is confined to the board/group just synced, and **a row with a
   link is never deleted** — it is marked `state = 'missing'`, so a link to an item
   archived in Monday degrades visibly instead of silently vanishing.
2. **Linked-item refresh** — background, every `poll_minutes` while the app runs.
   A single `items(ids: [...])` query covering exactly the linked ids across all
   projects. Cost is flat in board size. This is what roll-up writes read against.
3. **Link picker** — queries Monday live, never the mirror, so an item created
   thirty seconds ago is findable.

The client requests and tracks Monday's complexity budget on every response and
backs off before tripping it. A 429 retries against the returned reset hint rather
than a fixed delay.

### Write

Every trigger — task status change, link, unlink, task delete — funnels into a
single `scheduleRollup(itemId)`. There is one write path, not several.

**Roll-up.** A pure function in `rollup.ts` computes the value from the linked
tasks' statuses: a text column gets something like `3/5 done · 1 in review`, a
numeric column gets 0–100. Column type is resolved when the column is configured,
not per write. The write is skipped when the computed value is unchanged, which
keeps Monday's activity log readable.

Nexus's five Kanban columns collapse for roll-up purposes as follows. **Deploy
counts as done**; Review is reported separately because it is the state a human
most often wants to act on; Triage, To Do, and In Progress are all "open", with
In Progress broken out when non-zero.

| Kanban column | Roll-up bucket |
|---|---|
| Triage, To Do | open |
| In Progress | in progress |
| Review | in review |
| Deploy | done |

The percentage form is `done / total`, so a numeric column reads 0 until work
actually reaches Deploy.

**Updates.** Posted to the item's update thread, throttled per item by
`min_interval_minutes` (default 30). Events arriving inside a window **coalesce
into a single post at window end** rather than being dropped — the result is
"3 tasks moved to Review, 1 summary written", not three posts and not a silent
gap. Triggers are meaningful transitions only: task → Review, task → Deploy,
task summary written, agent run finished. Not every drag.

**The write invariant:** Nexus writes *only* the configured roll-up column and the
updates feed. It never writes the status column or any field a human owns. The two
parties write disjoint fields, so there is no read-modify-write conflict to lose
and no way for an agent to silently declare an initiative done.

Writes run as ActivityManager operations (kind `monday_write`), so they appear in
the Activity Console with retry and diagnostics, exactly like Jira and GitHub
syncs. A failed write never blocks a Kanban move: the task moves locally and the
write retries.

## Agent surface

### Context injection

Delivered through Pi's `ResourceLoaderOptions.systemPromptOverride`, not through
the transcript. That hook is re-evaluated whenever a session is created *or
resumed from disk*, so a thread reopened next week gets current item state rather
than a stale line frozen in message history — and the block stays out of the
conversation the model re-reads every turn.

Contents, hard-capped at roughly 400 tokens with updates truncated first: item
name, url, status, owners, dates, the sibling roll-up ("this task is 1 of 5 under
this initiative"), and the most recent updates. The block states explicitly that it
is a snapshot and that `monday_get_item` returns current state.

This is the same hook the follow-on session-preamble spec needs, so building it
here reduces that work to an extension of an existing mechanism.

### Tools

Registered by `createMondayExtension(...)` in `buildSessionExtensionFactories`,
alongside the memory extension.

| Tool | Availability |
|---|---|
| `monday_search(query, board_id?)` | Scoped to the project's board by default, widenable. |
| `monday_get_item(item_id)` | Column values, recent updates, and the Nexus tasks linked to it. |
| `monday_post_update(item_id, body)` | **Only when that project's `updates.enabled` is true.** |

Following the `memory_recall` precedent, the extension is omitted wholesale when
Monday is disabled or unconfigured, so a session never advertises a tool that
cannot run. Each tool carries a `promptSnippet`.

Guardrails on the single write tool:

- It routes through the same `writes.ts` throttle and Activity operation as the
  automated updates — one code path, so an agent cannot out-run the rate limit the
  automated path respects.
- Every agent-authored update carries a provenance line naming the Nexus task and
  thread. A human reading the item in Monday never has to guess who wrote it.
- It is approval-gated: a supervised thread parks it in the existing
  `ApprovalBroker` for allow/deny rather than firing.

## UI

**Per-project Project Management view**, a tab alongside Kanban. Lists the scoped
board's items grouped by Monday group; each row expands to reveal its linked Nexus
tasks and the current roll-up. Configuration of scope, roll-up column, and updates
opt-in lives in the project's settings.

**Linking is reachable from both ends**, because both are natural starting points:
from an item row in this view (pick tasks to attach), and from the task modal on
Kanban (pick an item). Both call the same `POST /api/monday/links` endpoint; the
picker component is shared.

**Kanban back-reference:** each card carries a badge for its linked item, clicking
through to that item. Because every card render needs link state, links are loaded
**with the task list**, not fetched per card.

## Error handling

**The failure mode most likely to bite:** Monday's GraphQL API returns **HTTP 200
with an `errors` array** for most failures — bad token, bad board id, malformed
query. A client that checks `res.ok` reads that as success and quietly mirrors
nothing. This is the same class of bug as the Jira one where a wrong `jira.user`
produced 200-and-empty instead of 401, and it cost real debugging time.
`client.ts` therefore treats `200 + errors[]` as a failure and maps the error code,
and "empty result" and "auth rejected" are never allowed to look alike in logs or
the Activity Console.

| Condition | Behaviour |
|---|---|
| `MONDAY_TOKEN` absent | Feature reports unconfigured in Settings and the trust snapshot. No recurring toast. |
| 200 with `errors[]` | Mapped to a typed `MondayError` with the code; surfaced distinctly from an empty result. |
| Complexity budget exhausted / 429 | Back off against Monday's reset hint; retryable Activity operation. |
| Item archived or deleted | Mirror row marked `missing`, link preserved, badge renders "item unavailable". |
| Roll-up column deleted | One failure, one notification, roll-up self-disables for that project. No retry loop. |

## Testing

The load-bearing logic is pure and tested without network:

- `map.ts` — item → mirror row.
- `rollup.ts` — linked task states → roll-up value, including the unchanged-value skip.
- `writes.ts` — coalescing-window behaviour: events inside a window merge into one
  post, and none are dropped.
- `sync.ts` prune rule — property: a row with a link is never deleted.

`client.ts` is tested with an injected `fetchImpl`, following the Jira client's
pattern, with explicit cases for **200-with-errors**, 429, and complexity
exhaustion.

Tool registration gets the `pi-runtime.test.ts` treatment: the extension is omitted
when Monday is unconfigured, and `monday_post_update` is omitted when updates are
disabled for the project.

Two hazards from past work, handled up front:

- Tests must `delete process.env.MONDAY_TOKEN` at the top, or a live token in the
  dev shell silently breaks the "unconfigured" cases — exactly what happened with
  `JIRA_TOKEN`.
- The migration is verified against a copy of the DB before touching the live one,
  and indexes for the new tables are created after the tables. The backend runs
  under `tsx watch` and re-runs migrations on the live DB, so a bad migration takes
  it down.
