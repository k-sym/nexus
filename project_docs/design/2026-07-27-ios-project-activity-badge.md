# iOS Projects list — activity status badge & activity sort

## Goal

On the iOS **Projects** list (`ProjectsListView`), each project row should carry
the same activity status badge vocabulary the desktop web client shows on the
project rail, and the list should sort projects with active (unclosed) sessions
to the top, then alphabetically.

## Background — the web vocabulary we mirror

`src/frontend/src/components/Sidebar.tsx` derives a per-project `SessionActivity`
from two feeds and paints a small corner dot on the project avatar:

| State     | Meaning                     | Dot colour (web)          |
|-----------|-----------------------------|---------------------------|
| `working` | a model is mid-run          | red (`bg-red-500`, pulses)|
| `waiting` | run is waiting for input    | amber (`bg-amber-400`, pulses) |
| `idle`    | live session, not running   | emerald (`bg-emerald-400`)|
| none      | no live/unclosed sessions   | no dot                    |

The web app derives this in `App.tsx` (`projectIdsByActivity`):

- **working / waiting** ← `/api/chat/active-runs`. Each run names its
  `projectId` and a `waitingForResponse` flag. `waitingForResponse` ⇒ waiting,
  else working.
- **idle (live)** ← a project has at least one unclosed session. On the desktop
  this comes from `/api/chat/sessions` plus the `chat_session_count` already on
  `/api/projects` (unarchived `chat_threads`). A project that is working/waiting
  is live by definition.

"Active / unclosed session" therefore means **`chat_session_count > 0`** — an
unarchived chat thread — which the iOS `Project` model already carries as
`chatSessionCount`.

## iOS approach

The iOS list already polls `/api/projects` (30s). We add a lightweight second
feed, `/api/chat/active-runs` (camelCase JSON), and merge it the same way the web
app does. We deliberately do **not** add the `/api/chat/sessions` feed on iOS:
`chatSessionCount` from `/api/projects` is sufficient for the `idle` (live) state,
and keeps the list to two cheap polls.

### Activity derivation (per project), mirroring `projectIdsByActivity`

1. If a run for the project has `waitingForResponse == true` → **waiting**.
2. Else if a run exists for the project → **working**.
3. Else if `chatSessionCount > 0` → **idle** (live but resting).
4. Else → **none** (no dot).

### Sort

`active first, then A→Z`:

- Group A: projects with any activity (`waiting|working|idle`, i.e. an unclosed
  or running session).
- Group B: the rest.
- Within each group, case-insensitive ascending by `name`.

This replaces the server's `sort_order` for the iOS list only (the desktop rail
still respects manual order). The request was explicitly activity-first then
alphabetical.

### Badge rendering

A 9pt corner dot on the project badge's bottom-right, matching the web colours:
- working → red, waiting → amber, idle → green. Working/waiting are the changing
  states; on iOS we do not pulse (keeps the list calm) but colour + accessibility
  label carry the meaning. `none` → no dot.

## Files

- `ios/NexusCore/.../Models/ActiveChatRun.swift` — `ActiveChatRun`,
  `ActiveChatRunsResponse`, and the shared `ProjectActivity` enum + derivation.
- `ios/NexusCore/.../Networking/Endpoint.swift` — `.chatActiveRuns`.
- `ios/NexusCore/.../Networking/APIClient.swift` — `activeChatRuns()` (plain/camel
  decoder).
- `ios/App/Nexus/Features/Projects/ProjectsListView.swift` — VM fetches both
  feeds, derives activity, sorts; `ProjectRow` gains the corner dot.

## Implementation notes (built)

- The pure derivation + sort logic lives in **NexusCore** (`ProjectActivity.derive`
  and `ProjectListItem.assemble`) so it is unit-testable without the App target.
  The SwiftUI `ProjectsViewModel` just calls `ProjectListItem.assemble(...)`.
- Poll cadence bumped from `.projects` (30s) to `.sessions` (5s) so RUN/WAIT
  transitions surface promptly, matching the desktop's ~2–5s feeds. `/api/projects`
  and `/api/chat/active-runs` are both cheap.
- The active-runs fetch is best-effort (`try?`): if it fails, the list still
  loads and activity falls back to `chatSessionCount`-only (idle/none). The
  projects fetch itself still surfaces errors via the normal error state.
- Dots do **not** pulse on iOS (deliberate — keeps the list calm); colour +
  accessibility label carry meaning. Colours: working=red, waiting=orange(amber),
  idle=green, mirroring the web `ACTIVITY_DOT`.
- Tests: `ios/NexusCore/Tests/NexusCoreTests/ProjectActivityTests.swift`
  (7 tests, all passing). Full NexusCore suite green (31). App target builds for
  the iOS 17 simulator.

## Testing checklist (for the testing agent)

- `active-runs` fixture decodes into `ActiveChatRunsResponse` (camelCase, with a
  `projectId: null` run tolerated).
- Activity derivation: waiting beats working beats idle beats none; a run with no
  matching project row is ignored for badges; `chatSessionCount == 0` with no run
  → none.
- Sort: a live/active project sorts above an inactive one regardless of name;
  ties broken A→Z case-insensitively.
- Row shows the dot in the right colour and an accessibility label; no dot when
  activity is none.
- List still renders if `/api/chat/active-runs` fails (older/broken backend):
  activity falls back to `chatSessionCount`-only (idle/none), list still loads.
