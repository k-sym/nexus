# Ticket to session

**Intent:** `intent/2026-09-08-ticket-to-session.md`
**Issue:** [#432](https://github.com/k-sym/nexus/issues/432)
**Status:** Implementation
**Date:** 2026-09-08

## Problem

The Jira mirror and its status grouping work. The step after clicking a ticket
does not: the sidebar's only action creates a Kanban task, and the ticket body
is forwarded mail, signatures and disclaimers around one line of real problem.
Keith reads the ticket in Jira and hand-writes the opening prompt for a session
every time, on the laptop or the phone.

## Goals and non-goals

Goals

- From a ticket, on web and iOS: draft the real problem with Sonnet, pick a
  project and a model, edit the prompt and branch, press Go, land in a session
  whose first turn is the edited prompt.
- Tickets with a session show it, and link to it.
- Session replaces the Kanban task path from Tickets.

Non-goals

- Any write to Jira. Keith closes tickets in Jira.
- Kanban, tasks, the GitHub issue triage sync. Kanban is reworked separately.
- The poll loop, JQL, content rules, notifications, restart-to-apply config.
- Switching the composer's next-message suggestion to Sonnet (follow-on).

## Decisions

### Drafting runs as a one-shot Claude Agent SDK query, not a thread

The engine is session-shaped and every thread persists a JSONL and claims the
project. A draft is stateless: one prompt in, one JSON object out. So it calls
`query()` directly with `tools: []`, `maxTurns: 1`, `persistSession: false`,
a plain string system prompt, `settingSources: []`, and the same
`resolveClaudeAuthEnv` the engine uses. Nothing it produces is a session, and
it cannot touch the project checkout (`cwd` is `~/.nexus`).

### The draft model is one config key, default Sonnet

`jira.draft_model` (a `provider/id` model key, default
`claude-code/claude-sonnet-5`). Only `claude-code/*` keys are accepted; any
other provider returns 400 with a message naming the key. Keith asked for
Sonnet through the subscription harness explicitly; the key exists so the
model can move without a code change.

### The backend composes the first turn

Web, iOS and the backend would otherwise each hold a copy of the trailer
(branch, push, do not touch Jira) and drift. The Go route takes the edited
problem and branch name and returns `{ thread, firstTurn }`; the clients send
`firstTurn` verbatim through the existing stream route with the chosen model.

### The ticket-to-session link lives on the thread

The poll replaces every ticket row on each cycle, so a ticket closed in Jira
vanishes from the mirror. A `ticket_key` column on `chat_threads` survives
that, keeps the thread's origin in the audit ledger, and lets the ticket list
derive its badge by join. Additive migration, one column plus an index.

### Draft is a button, not automatic on select

A Sonnet call per click while browsing the list is waste and cost. Draft runs
on "Draft with Sonnet"; the button fetches a fresh description first so the
draft never reads a stale cache.

### Branch convention is SSUK's, verbatim

`<fix|hotfix|feature>/SUP123-short-description`: the Jira key with its hyphen
removed, then lowercase hyphenated words. Sonnet proposes type and name;
Keith edits. The trailer tells the agent to create and push that branch.

## Architecture

### Backend

- `src/backend/tickets/draft.ts`
  - `buildDraftPrompt(input)` pure: ticket key, summary, cleaned body, project
    list (id, name, description) → the user message.
  - `parseDraft(text, projects)` pure: tolerant JSON extraction (fences, prose
    around the object), validates `branchType`, normalises `branchName` to the
    convention, maps a suggested project name/id to a known project id or null.
  - `draftTicket(deps)` orchestrates with an injectable `generate` so tests
    never spawn the CLI. Production `generate` is `runClaudeOneShot` in
    `src/backend/engines/claude/one-shot.ts`.
  - `buildFirstTurn({ key, url, summary, problem, branchName })` pure: the
    prompt plus the fixed trailer.
- `src/backend/routes/tickets.ts`
  - Extract `loadDescription(db, key, refresh)` from the description route so
    draft and the route share it.
  - `POST /api/tickets/:key/draft` → `TicketDraft`. 404 unknown ticket, 400 bad
    draft model, 502 when the model fails or returns nothing parseable.
    Emits an Activity operation of new kind `ticket_draft` with the model.
  - `POST /api/tickets/:key/session` body `{ projectId, problem, branchName }`
    → `{ thread, firstTurn }`. Creates the thread titled `SUP-123 summary`,
    stamps `ticket_key`. 404 unknown ticket or project, 400 empty problem.
  - `GET /api/tickets` gains `session: { thread_id, project_id } | null` per
    ticket (latest non-archived thread with that key).
- `src/backend/db.ts`: `ALTER TABLE chat_threads ADD COLUMN ticket_key TEXT`,
  index on it.
- `src/shared/index.ts`: `Ticket.session`, `ChatThread.ticket_key`,
  `TicketDraft`, `TicketSessionResult`, `jira.draft_model`, `'ticket_draft'`
  in `OPERATION_KINDS`.
- `src/backend/config.ts`: default `draft_model`.

### Web

- `TicketsView` sidebar: metadata and Jira link as now, then
  `TicketSessionPanel`: Draft with Sonnet, project `<select>`, model
  `<select>` over the curated list (`useModels`), branch type + name, editable
  prompt textarea, Go. When the ticket has a session: "Open session" instead.
  `TriageToProject` and `onCreateTask` go.
- List rows: a small "session" pill on tickets with one.
- App: `handleTicketGo(key, { projectId, problem, branchName, modelKey })`
  calls the session route, seeds ChatPanel via the existing `taskSeed`
  mechanism with `firstTurn` and `modelKey`, reloads threads, selects the
  thread.
- Settings → Jira: "Draft model" text field.
- Activity Console: `ticket_draft: 'Ticket draft'`.

### iOS

- NexusCore: `TicketDescription`, `TicketDraft`, `TicketSessionResult`,
  `Ticket.session`; endpoints `ticketDescription`, `ticketDraft`,
  `createTicketSession`; `OperationKind.ticketDraft`.
- App: list rows push `TicketDetailView` (summary, metadata, Jira link,
  description, Draft, project picker, model picker, branch, prompt editor,
  Go). Go calls the session route then sets `router.openThread` with a new
  optional `seed` (text + model key). `ChatViewModel` consumes a seed once
  after history loads, the same way the DEBUG autosend does. Rows with a
  session show a badge; detail offers "Open session".

## Acceptance criteria

1. `POST /api/tickets/SUP-1/draft` with a stubbed generator returns problem,
   projectId, branchType, branchName in convention form; 404 unknown key;
   400 when `jira.draft_model` is not a `claude-code/*` key.
2. `POST /api/tickets/SUP-1/session` creates a thread with `ticket_key`,
   titled from the ticket, and `firstTurn` contains the edited problem, the
   ticket key and URL, the branch name, "push" and "do not" touch Jira.
3. `GET /api/tickets` shows `session` for that ticket and null for others.
4. Existing description and sync tests still pass; typecheck green.
5. Web: TicketsView tests cover draft → edit → Go calling the handler with
   the edited values, and the session badge.
6. NexusCore tests decode the new shapes and the session-bearing ticket.
7. On baker-pro: a real ticket drafted, Go pressed, the session's first turn
   is the edited prompt (verified from the thread's messages).

## Implementation plan

1. Shared types, config default, migration, README, Activity kind.
2. `draft.ts` pure functions + tests; `one-shot.ts`.
3. Routes + tests (draft, session, list with session).
4. Web panel, App wiring, Settings field, tests.
5. NexusCore models/endpoints + tests; iOS detail view, seed, badge.
6. Build, deploy to baker-pro, walk a real ticket, As-built note, PR.

## For the testing agent

- Run backend tests with `JIRA_TOKEN` unset.
- The draft never spawns the CLI in tests: inject `generate`.
- Branch name normalisation: `SUP-123` → `SUP123`; spaces and punctuation →
  single hyphens; lowercase; max ~60 chars after the type.

## As built

Built 2026-09-08 on `feat/ticket-to-session` (#432). Everything in the
architecture section landed as written, with these notes:

- **Routes.** `POST /api/tickets/:key/draft`, `POST /api/tickets/:key/session`;
  `GET /api/tickets` now carries `session`. The description route's body is
  shared with the draft through `loadDescription`.
- **Config.** `jira.draft_model` (default `claude-code/claude-sonnet-5`), a
  "Draft model" field under Settings → Jira.
- **Migration.** `chat_threads.ticket_key` + index. The fresh-DB schema still
  had `agent_id TEXT NOT NULL` on `chat_threads` while the live DB dropped it
  in Phase 5, so any thread insert on a new database failed; it now defaults
  to `''`. Existing databases are untouched.
- **Web.** `TicketSessionPanel` replaces `TriageToProject` (deleted). Go uses
  the existing task-seed path in `ChatPanel`, so the first turn is sent the
  same way "Run task" sends its seed.
- **iOS.** `TicketDetailView`; `OpenThread` gained `title` and `seed`, and
  `ChatViewModel` sends a seed once after history loads (beside the DEBUG
  autosend). Simulator build green; phone walkthrough is Keith's.
- **Live verification on baker-pro.** Drafted SUP-1058 ("FW: Scoring", the
  example from the interview): Sonnet returned the 8AOFI / missing last score
  problem, picked MyWise Pro and `fix/SUP1058-report-score-not-showing` in
  5.9 s, recorded as a `ticket_draft` operation. Go created thread
  `c7c38310-…` titled "SUP-1058 FW: Scoring" with `ticket_key` set; the list
  showed the session badge; the first turn sent through the stream matched
  the composed text verbatim, and Sonnet started by creating the branch. The
  run was aborted after ~15 s so nothing was pushed; the checkout was put
  back on its feature branch and the empty local branch removed. The thread
  is still there to resume.
- **Found on the way, not fixed here.** The launchd backend on baker-pro has
  no `JIRA_TOKEN` (not in the plist, not in `.env`), so the native poll has
  been dormant and the mirror was last synced 2026-07-03. Drafting still works
  from cached descriptions (11 of 21 tickets have one) but fresh tickets and
  `?refresh=1` need the token in the backend's environment.
- **Not done.** The web UI click path was verified by the component tests,
  not by hand against baker-pro: the backend is token-gated and driving the
  dev frontend would have meant pasting the server token into a browser
  session log.

## As built (2026-09-08, fix/ticket-draft-trailing-comma)

- **Fault.** Reproducing SUP-1317 four times, one reply came back as a
  ```` ```json ```` fence with a trailing comma before the closing brace
  (`"branchDescription": "tbt-download-export",\n}`). `JSON.parse` rejected
  it, `extractJsonObject` returned null, and the route answered 502 "nothing
  usable" with no trace of the model text anywhere.
- **Parser.** `extractJsonObject` keeps the balanced-brace scan; when the
  strict parse throws it retries once after stripping trailing commas before
  `}` / `]` outside strings (`stripTrailingCommas`, exported for tests).
  Prose, refusals and truncated objects still yield null.
- **Diagnostics.** `draftTicketRaw` returns `{ draft, text }`; `draftTicket`
  wraps it and keeps its `TicketDraft | null` shape. On a null draft the
  route writes `[ticket-draft] <key> (<model>) unusable reply, N chars:` plus
  the first 2 KB of the reply to stderr (so `~/Library/Logs/nexus-backend.log`)
  and puts `{ rawLength, rawSnippet }` (300 chars) in the `ticket_draft` stop
  event's `diagnostics`, visible in the operations ledger.
- **Tests.** `ticket-draft.test.ts`: the exact fenced sample, a trailing comma
  inside a nested array with a `, }` inside a string, and the raw-text
  return. `tickets-session-routes.test.ts`: the 502 path now asserts the
  stderr line and the stop-event diagnostics. Backend suite 1148 pass / 0
  fail; typecheck clean; backend `dist/` built.
