# Session-first Kanban — design spec
Intent: `intent/2026-09-08-session-first-kanban.md` · Issue: k-sym/nexus#439 · Designed with Keith 2026-09-08.
Follows Ticket to session (`project_docs/design/2026-09-08-ticket-to-session.md`, #432) and the Monday
design (`project_docs/design/2026-07-22-monday-project-management-design.md`, #255).

## Problem

The board is a task board in a product where the unit of work is now a session.
Tasks are a parallel object nobody maintains: on baker-pro 77 of 79 tasks are
GitHub issues parked in Triage by the sync, 3 cards have a chat, and the five
hand-moved columns say nothing about what the agents are doing. Since #432 a
ticket becomes a session directly; the board should show sessions, where they
came from, and what state they are in, and be the place to start one from a
GitHub issue or a Monday item the way Tickets starts one from Jira.

## Goals and non-goals

Goals
- Cards are chat threads. Each carries its origin: Jira ticket, GitHub issue,
  Monday item, or plain chat.
- Lanes are derived from live state, no dragging: Inbox, Running, Needs you,
  Idle, Done.
- Inbox lists the project's open GitHub issues and Monday items with no session
  on the board; one click runs Draft with Sonnet → project, model, branch,
  prompt → Go, and Go opens a session stamped with the origin.
- Monday roll-up, status write-back, updates feed and agent context keep
  working, now from linked sessions.
- Web and iOS together; NexusCore models and tests.

Non-goals
- Tickets, the Jira poll, the next-message suggestion (#432, #434): untouched.
- No new write to GitHub, Monday or Jira; nothing new on agent tool surfaces.
- No parking on the board: the + button goes to Ideas. The two hand-made tasks
  are re-filed as ideas by Keith.
- No migration of task rows into threads. `tasks` and `task_monday_links` stay
  as tombstones (`~/.nexus/nexus.db` is the audit ledger).

## Decisions

### D1 — The board is a projection, computed on read
`GET /api/projects/:id/board` assembles cards and Inbox in one call from
`chat_threads`, the in-memory run registry, pending questions and approvals,
the GitHub issue cache and the Monday mirror. Nothing is stored per lane, so
there is nothing to drift. Reason: every lane is a fact Nexus already knows;
storing it again would recreate the stale-status problem the task board has.

### D2 — Lane derivation
- Inbox: a GitHub issue or Monday item in the project's scope with no card on
  the board (see D4 for "on the board").
- Running: thread has an active run and nothing pending.
- Needs you: thread has an active run with a pending `question` or a pending
  tool approval.
- Idle: not archived, no active run.
- Done: archived in the last 30 days.
Reason: these are the four states Keith acts on; anything finer (PR open,
branch pushed) needs GitHub reads the board does not do yet.

### D3 — Origins live on the thread
`chat_threads` gains `github_issue INTEGER NULL` (additive, indexed). The Jira
origin is the existing `ticket_key`. The Monday origin is a link row (D5).
The API derives `origin` with precedence ticket → github → monday → chat.
Reason: mirrors #432's shape; one column per origin keeps each feed's dedupe
query a plain index lookup.

### D4 — "On the board" is the dedupe rule for the Inbox
An issue or item leaves the Inbox when any card with that origin is on the
board: a non-archived thread, or one archived in the Done window. After the
window it reappears if still open in GitHub or active in Monday. Reason: the
rule a user can state in one sentence, and it means a finished issue Keith has
not closed in GitHub resurfaces instead of vanishing.

### D5 — Monday links move from tasks to threads, table for table
New table `thread_monday_links (thread_id PK, item_id, project_id, created_at)`
with the same semantics as `task_monday_links` (one item per thread, user
intent, survives a mirror wipe). Migration copies every task link whose task
has a `thread_id`. The Monday store's functions keep their names with `Task`
→ `Thread` (`linkThread`, `unlinkThread`, `getLinkForThread`,
`listLinksForProject`, `listLinkedItemIds`, `listLinkedThreadStatuses`).
Reason: the roll-up, status sync, stale report, updates feed, session context
and tool all reach items through the store; a like-for-like table makes that
a mechanical rename rather than a redesign, and keeps the store's own tests.

### D6 — Monday stages map derived lanes onto the existing five statuses
`listLinkedThreadStatuses` returns `TaskStatus[]` derived per thread:
archived → `deploy`, running (with or without a pending gate) → `in_progress`,
otherwise → `review`. Inbox has no thread and contributes nothing. Reason:
`MONDAY_ROLLUP_BUCKETS`, `status_labels` in the per-project Monday config,
the Settings section and the four write guards are all keyed by `TaskStatus`;
mapping onto them leaves that surface, its config merge and its tests intact.

### D7 — Monday triggers fire on link, run end and archive
A tiny `chat/run-registry.ts` singleton owns the running set (chat.ts's claim
map writes to it) and emits start/stop. `monday/thread-hooks.ts` subscribes:
on stop → roll-up, status sync (no advance off a human label), feed move
`review`; the archive route → the same with `deploy`; the link routes and the
Go route → roll-up + status sync with the ownership handoff (`true`), as the
link route does today. Reason: replaces the task PUT as the one place Monday
learned about lifecycle changes, without the chat stream knowing Monday exists.

### D8 — Inbox reads GitHub live through a cache; the sync stops writing tasks
`github/inbox.ts` replaces `github/sync.ts`: `listOpenIssues(project)` fetches
with the same 3-minute per-project throttle, keeps the last result in memory
(so a throttled call still returns issues), keeps the error dedupe, and emits
the existing `github_sync` Activity kind. Honour `github.enabled`. Reason:
issues were only ever copied into tasks so the board could show them; the
board can show them directly.

### D9 — Draft and Go reuse the ticket module's pure pieces without editing it
`board/draft.ts` imports `DRAFT_SYSTEM_PROMPT`, `extractJsonObject`,
`resolveProjectId`, `isBranchType`, `slugify` from `tickets/draft.ts` and adds
its own input builder, branch builder and first-turn trailer. Reason: the #432
module stays byte-identical (constraint), while the model prompt, parsing and
project mapping are shared so both flows drift together.

### D10 — Board branches follow the repo convention, not SSUK's
Origins from GitHub and Monday get `<feat|fix|hotfix>/<slug>`
(`BOARD_BRANCH_TYPES`), the number or item goes in the first turn's Source
line. Tickets keep `fix/SUP123-…`. Reason: AGENTS.md names `feat/<slug>`,
`fix/<slug>`; the SSUK form is a client convention that only applies to Jira.

### D11 — First-turn trailer for board origins
Problem, blank line, `Source: GitHub issue #N (url) — "title".` or
`Source: Monday item "name" (url).`, then: create and work on the branch;
reproduce or locate before changing code; when done commit and push the
branch; do not open a PR or merge; do not close, comment on or edit the issue
or item. Reason: same shape as #432 so a session's first turn reads the same
whatever it came from, and the external system stays untouched by the agent.

### D12 — Diff review becomes a session action
The Review/Deploy card button and the three task-creating review actions go.
`DiffReviewPanel` opens from an Idle or Running card and offers one action,
"Attach to this session", which seeds the card's own thread with the hunk
prompt. `POST /api/projects/:id/review-actions` accepts `thread_id` and only
`attach_to_chat`; `ReviewAction` narrows to that one value. Reason: the other
actions only created task rows, which no longer show anywhere.

### D13 — Legacy task routes stay one release, stripped of side effects
`GET/POST /api/projects/:id/tasks`, `PUT/DELETE /api/tasks/:id` remain as
plain CRUD with the Monday and summarise hooks removed. `POST
/api/projects/:id/github/sync` is deleted. Reason: nothing in web or iOS calls
the task routes after this change; keeping them a release costs nothing and
avoids a hard break for any stale client, while the hooks would otherwise
write to Monday from a tombstone.

### D14 — The + button files an idea
On web the board's + jumps to the Ideas view; on iOS it pushes the existing
Ideas surface. The palette's "New task (Triage)" becomes "New idea".
Reason: Keith's call in the interview: parked work belongs in the Ideas
workflow, and graduated ideas arrive in the Inbox as issues on their own.

## Architecture

### Schema (additive, `src/backend/db.ts`)
- `ALTER TABLE chat_threads ADD COLUMN github_issue INTEGER`; index
  `idx_chat_threads_github_issue (project_id, github_issue)`.
- `CREATE TABLE IF NOT EXISTS thread_monday_links (thread_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL)`
  with indexes on `item_id` and `project_id`.
- One-shot backfill guarded by a `schema_migrations`-style marker row (or by
  "table just created"): `INSERT OR IGNORE INTO thread_monday_links SELECT
  t.thread_id, l.item_id, l.project_id, l.created_at FROM task_monday_links l
  JOIN tasks t ON t.id = l.task_id WHERE t.thread_id IS NOT NULL`.

### Shared types (`src/shared/index.ts`)
- `ChatThread.github_issue?: number | null`.
- `BOARD_LANES = ['inbox','running','needs_you','idle','done']`,
  `BOARD_LANE_LABELS`, `BoardLane`.
- `BoardOrigin` union: `{kind:'ticket', key, url}` | `{kind:'github', number,
  url}` | `{kind:'monday', item_id, name, url}` | `{kind:'chat'}`.
- `BoardCard { thread: ChatThread; lane: Exclude<BoardLane,'inbox'>; origin;
  running: boolean; pending_questions: number; pending_approvals: number;
  monday_item_id: string | null }`.
- `BoardInboxItem { kind:'github'|'monday'; id: string; title: string; url:
  string | null; labels: string[]; status_label: string | null; updated: string
  | null }`.
- `BoardResponse { cards: BoardCard[]; inbox: BoardInboxItem[]; inbox_errors:
  { github?: string; monday?: string } }`.
- `BOARD_BRANCH_TYPES = ['feat','fix','hotfix']`, `BoardBranchType`.
- `OriginRef { kind: 'github'|'monday'; id: string }`, `OriginDraft { origin;
  problem; projectId; branchType: BoardBranchType; branchName; model }`,
  `OriginSessionRequest { kind; id; projectId; problem; branchName }`,
  `OriginSessionResult { thread; firstTurn }`.
- `MondayItemWithLinks.thread_ids` replaces `task_ids`; `ThreadMondayLink`
  beside the kept `TaskMondayLink`.
- `ReviewAction = 'attach_to_chat'`; `ReviewActionRequest.thread_id`.
- `KANBAN_COLUMNS`, `Task`, `TaskStatus` stay (Monday buckets and legacy
  routes use them); the doc comment says the board no longer does.

### Backend
- `src/backend/chat/run-registry.ts`: `markRunning(threadId, meta)`,
  `markStopped(threadId)`, `isRunning`, `list()`, `onChange(listener)`.
  `routes/chat.ts` calls mark/stop inside `claimThreadRun`/`releaseThreadRun`.
- `src/backend/github/inbox.ts` (D8). `github/sync.ts` deleted.
- `src/backend/board/lanes.ts`: pure `deriveLane({ archived_at, running,
  pending_questions, pending_approvals })` and `laneToTaskStatus(lane)` (D6).
- `src/backend/board/draft.ts` (D9–D11): `buildOriginDraftInput`,
  `buildBoardBranchName`, `parseOriginDraft`, `draftOrigin(deps)`,
  `buildOriginFirstTurn`.
- `src/backend/routes/board.ts`:
  - `GET /api/projects/:id/board?refresh=1`: threads (non-archived + archived
    within 30 d) → cards; Inbox from `listOpenIssues` (when `github.enabled`
    and a GitHub remote parses) and `listItemsForBoard` filtered to `active`
    (when the project has a Monday scope); dedupe per D4; feed failures land
    in `inbox_errors`, never fail the board.
  - `POST /api/projects/:id/board/draft` `{kind,id}` → `OriginDraft`; 404 when
    the origin is not in the current Inbox source; 400 bad draft model; 502
    model failure; Activity kind `ticket_draft` reused with title `Draft #N`.
  - `POST /api/projects/:id/board/session` `{kind,id,projectId?,problem,
    branchName}` → `{thread, firstTurn}`; stamps `github_issue` or inserts the
    Monday link (and schedules roll-up + status sync with handoff); title
    `#N title` or the item name.
  - Draft model: `jira.draft_model` (already exists, default Sonnet). No new
    config key.
- `src/backend/monday/*` (D5–D7): store rename; `session-deps.resolveThreadItem`
  reads the link table directly; `stale.ts`, `writes.ts`, `status-sync.ts`,
  `trigger.ts`, `updates-feed.ts` (`scheduleFeedMove(db, {id,title,status})`),
  `sync.ts` follow the store; new `thread-hooks.ts` registered from
  `index.ts` after the registry exists. `routes/monday.ts`: items carry
  `thread_ids`; `POST /links` takes `thread_id` (404 unknown thread, 400 wrong
  project); `DELETE /links/:threadId`.
- `routes/projects.ts` (D12, D13): review-actions rewritten around
  `thread_id`; task routes stripped; github/sync route removed; the project
  list keeps `task_count` for old clients.
- `routes/chat.ts`: archive route calls the Monday `deploy` hook after a
  successful archive.

### Web
- `KanbanBoard.tsx` rewritten: props `{ board, projectId, onOpenThread,
  onOpenInboxItem, onNewIdea, onOpenDiffReview }`. Five lanes; Inbox is a
  compact list with a filter box (Nexus has 77 open issues) and a kind badge;
  cards show title, origin badge, model, relative last activity, Monday badge,
  and a Diff button on Idle/Running. No drag handlers.
- `OriginSessionPanel.tsx`: the Tickets panel's form for a `BoardInboxItem`
  (Draft with Sonnet, project, model, type feat/fix/hotfix, branch, prompt,
  Go). Own component; `TicketSessionPanel` untouched. Shown in a right-hand
  drawer over the board when an Inbox row is selected.
- `App.tsx`: board state + 5 s poll while `subView === 'kanban'` and a refetch
  when `runningThreadIds` changes; `handleOriginGo` mirrors `handleTicketGo`;
  GitHub sync effect, task state, `TaskModal`, `TaskModelPicker`,
  `handleRunTask`, `handleMoveTask`, `handleOpenTask` removed; palette "New
  idea"; Diff review opens with `{ threadId, title }`; sidebar counts show
  sessions.
- `ProjectManagementView.tsx`: "Attach existing session…" over the project's
  unlinked threads; chips are session titles that open the thread
  (`onOpenThread` replaces `onNavigateToKanban`); "Create task in Triage"
  removed. `MondayItemPicker.tsx`, `TaskModal.tsx`, `TaskModelPicker.tsx`
  deleted with their tests.
- `api.ts`: `projects.board`, `projects.boardDraft`, `projects.boardSession`,
  `monday.link(threadId, …)`, `monday.unlink(threadId)`; task and github-sync
  helpers removed.
- `ActivityConsole`: no new kind.

### iOS
- NexusCore: `BoardResponse`, `BoardCard`, `BoardLane`, `BoardOrigin`,
  `BoardInboxItem`, `OriginDraft`, `OriginSessionRequest/Result`; endpoints
  `projectBoard`, `boardDraft`, `createBoardSession`; `ChatThread.githubIssue`.
  `ProjectTask`, `UpdateTaskRequest`, `projectTasks`, `updateTask` removed
  with their tests (M1 fixtures adjusted). `Project.taskCount` stays optional.
- App: `BoardView` replaces `KanbanBoardView` + `TaskEditSheet`: a `List`
  with one section per lane (phone width), Inbox rows push
  `OriginDetailView` (the Tickets detail form for an Inbox item; Go sets
  `router.openThread` with the seed, like `TicketDetailView`); cards open the
  thread; toolbar + pushes `IdeasView`. Hub row "Board" stat becomes
  "N sessions" from `chatSessionCount`. `RootShellView` debug case `board`
  points at `BoardView`. Pull-to-refresh and a 5 s refresh while visible.

## Acceptance criteria

1. `deriveLane` returns running / needs_you / idle / done for the four input
   combinations and `laneToTaskStatus` maps them to in_progress / in_progress /
   review / deploy.
2. `GET /api/projects/:id/board` on a project with two threads (one running per
   the registry, one archived yesterday), a stubbed GitHub feed of three issues
   and a Monday scope of two active items, where one issue and one item are
   stamped on the threads, returns two cards in the right lanes and an Inbox of
   two issues and one item; a stubbed GitHub failure lands in `inbox_errors`
   with the cards intact.
3. `POST /board/draft` with an injected generator returns an `OriginDraft`
   whose branch is `<type>/<slug>` for `feat|fix|hotfix`; 404 for an id not in
   the Inbox.
4. `POST /board/session` for a GitHub issue creates a thread with
   `github_issue = N` titled `#N title`, and `firstTurn` contains the problem,
   the issue URL, the branch, "push", "do not open a PR" and "do not close".
   For a Monday item it inserts a `thread_monday_links` row and the trailer
   says Monday is not written to.
5. A fresh DB has `thread_monday_links`; a DB with a task link whose task has
   a `thread_id` gets the row copied once and never duplicated on restart.
6. Monday roll-up, status sync, stale report, updates feed, session context
   and tool tests pass against thread links; `listLinkedThreadStatuses`
   derives statuses from archive state and the run registry.
7. Review actions: `attach_to_chat` with `thread_id` seeds that thread; the
   old actions are rejected with 400.
8. Web: KanbanBoard renders five lanes from a `BoardResponse`, filters the
   Inbox, opens a thread on card click and the origin panel on an Inbox click;
   OriginSessionPanel draft → edit → Go calls the handler with the edited
   values; ProjectManagementView attaches a session and shows session chips.
9. NexusCore decodes a board fixture with all four origins and an
   `OriginSessionResult`; the ticket decoding tests still pass.
10. Typecheck, backend, frontend and NexusCore tests green; iOS simulator
    build green.
11. On baker-pro: board shows the real Inbox; Go on a real GitHub issue opens
    a thread stamped with the number whose first turn is the composed text;
    the card is in Running; the run is aborted within seconds and the checkout
    restored; screenshots before and after.

## Implementation plan

Build order (each step typechecks and its tests pass before the next):
1. Shared types; `db.ts` migration + `db.test.ts`; run registry; `lanes.ts` +
   tests.
2. Monday re-point: store, session-deps, stale, writes, status-sync, trigger,
   updates-feed, sync, thread-hooks, routes/monday; their tests.
3. `github/inbox.ts` + test; delete `sync.ts`; projects.ts task/route strip,
   review-actions; `routes-projects` / `git-diff` tests.
4. `board/draft.ts` + tests; `routes/board.ts` + tests; register; chat.ts
   registry calls and archive hook. Demoable from here with curl.
5. Web: api, KanbanBoard, OriginSessionPanel, App, ProjectManagementView,
   DiffReviewPanel, deletions, tests.
6. iOS: NexusCore models/endpoints/tests; BoardView, OriginDetailView, hub,
   shell; simulator build.
7. README (Kanban section, API table, GitHub triage row, troubleshooting),
   Activity docs; build; deploy to baker-pro; live walk; As-built; PR.

Risks and containment
- Monday rename misses a call site → typecheck catches renamed exports; the
  fifteen Monday test files run against the new table.
- Run registry double-counting a thread → the registry is written only from
  the existing claim/release pair, and `list()` is what `/active-runs` already
  returned.
- Inbox latency: GitHub fetch on first open → cache returns the last result
  under throttle, the board never waits on Monday (mirror read only; `refresh=1`
  is explicit).
- Old iOS build on the phone hitting removed routes → task routes stay (D13);
  the board endpoint is new so the old board simply shows the old tasks until
  the app is rebuilt.
- Live Go pushes to a real repo → abort with `{"source":"user"}` within
  seconds, restore the checkout branch, delete the empty local branch.

Proof
- Automated: the tests named per step above.
- Manual: simulator build (`xcodebuild … CODE_SIGNING_ALLOWED=NO`), the
  baker-pro walk in criterion 11, phone walkthrough by Keith.

Deploy: baker-pro, `npm run build && ./scripts/restart-backend.sh`; no new
config key; the migration runs on first boot.

## For the testing agent

1. Backend tests with `JIRA_TOKEN` unset; the "orientation block" test is a
   known non-failure.
2. Board route: build a DB with `getDb(':memory:')`, insert a project and
   threads, mark one running via the registry, inject `listOpenIssues` and the
   Monday item source; never hit the network.
3. Draft: inject `generate`; assert branch normalisation for each type.
4. Monday: run the whole `monday-*` set; the only intended behaviour change is
   the link subject (thread) and the derived statuses.
5. Web: `KanbanBoard.test.tsx`, `OriginSessionPanel.test.tsx`,
   `ProjectManagementView.test.tsx`, `DiffReviewPanel.test.tsx`, `App.test.tsx`.
6. iOS: `swift test` in `ios/NexusCore`, then the simulator build.

## As built

Built 2026-09-09 on `feat/session-first-kanban` (#439). The architecture landed as
written, with these notes:

- **Routes.** `GET /api/projects/:id/board` (`?refresh=1` bypasses the GitHub
  cache), `POST /api/projects/:id/board/draft`, `POST /api/projects/:id/board/session`.
  `POST /api/projects/:id/github/sync` is gone; `POST /api/projects/:id/review-actions`
  accepts only `attach_to_chat` with `thread_id`. Task routes remain as plain
  CRUD (D13). Monday: `POST /api/monday/links` takes `thread_id`;
  `DELETE /api/monday/links/:threadId`; items carry `thread_ids`.
- **Migration.** `chat_threads.github_issue` + index, `thread_monday_links` +
  indexes, one-shot backfill keyed on the table's absence. On baker-pro the
  backfill copied the one task link whose task had a session (MyWise Pro item
  12597803377); the other link's task had never started and stays in the
  tombstone table.
- **Draft prompt.** D9 said the ticket system prompt would be imported; the
  board has its own `BOARD_DRAFT_SYSTEM_PROMPT` because "forwarded email chain"
  is wrong for an issue. Parsing, project mapping and `slugify` are imported
  from `tickets/draft.ts`, which is byte-identical to `main` (the trailing-comma
  tolerance from #442 arrived by rebase and applies to both flows).
- **Run registry.** `chat/run-registry.ts` is written only from the existing
  claim/release pair in `routes/chat.ts`. `monday/thread-hooks.ts` subscribes
  to it; the archive route calls `onThreadArchived`; the link routes and the
  Monday Go path call `onThreadLinked` (ownership handoff).
- **Monday wording.** Roll-up text now reads "no linked sessions"; the agent
  context block says "Monday.com initiative for this session"; the tool returns
  `linked_sessions`. Config shape and guards are unchanged (D6).
- **Web.** `KanbanBoard` rewritten (no drag), `OriginSessionPanel` beside it,
  `DiffReviewPanel` takes a thread, `ProjectManagementView` attaches sessions.
  `TaskModal`, `TaskModelPicker`, `MondayItemPicker` deleted. Sidebar counts
  show sessions only. `ChatThread.last_model_key` was added to shared so the
  card can show the model without a cast.
- **iOS.** `BoardView` + `OriginDetailView` replace `KanbanBoardView` and
  `TaskEditSheet`; NexusCore `Board.swift` models, endpoints and 11 decoding
  tests; `ProjectTask` and the task endpoints removed. Simulator build green;
  phone walkthrough is Keith's.
- **Removed with tasks.** `github/sync.ts`, `memory/summarize.ts` (the
  task-transition summary; archive already summarises a session), and their
  tests.
- **Verification.** Typecheck green; backend 1159 tests, frontend 511, NexusCore
  127, all green with `JIRA_TOKEN` and `MONDAY_TOKEN` unset.
- **Live on baker-pro (this commit deployed detached from the main checkout).**
  The Nexus board opened with four open issues in the Inbox and no cards.
  Clicking #221 opened the origin panel; Draft with Sonnet returned the
  distilled problem, project Nexus and `feat/create-github-issue-from-triage`
  in 3.1 s, recorded as a `ticket_draft` operation titled "Draft #221". Go
  created thread `b772512b-…` titled "#221 Nexus Kanban - New Issue" with
  `github_issue = 221`; the first user message matched the composed first turn
  verbatim (problem, Source line with the issue URL, branch, push, no PR, do
  not touch the issue). The run was aborted with `{"source":"user"}` after 11 s
  (`run_end … status: cancelled, abortSource: user`); the agent had not created
  a branch, and `git status` on the checkout was clean. The board then showed
  the Inbox at three and the card in Idle with its `#221` badge and model. A
  second short turn ("write three paragraphs on your approach, touch nothing")
  put the card in Running with the live dot on the board and the RUN pill in
  the sidebar; it finished on its own, again without touching the checkout.
  Screenshots are in the build session transcript.
- **Follow-ups, not this build.** The origin panel's model select does not
  default to Sonnet when the composer has no active model (Tickets has the same
  behaviour); the two hand-made tasks are still in the `tasks` table for Keith
  to re-file as ideas; `iOS` phone walkthrough.
