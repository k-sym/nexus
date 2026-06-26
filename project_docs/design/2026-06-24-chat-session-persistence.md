# Chat session persistence (issue #107)

## Problem

Reported in https://github.com/k-sym/nexus/issues/107:

- After the app closes (backend restart) or after returning to an inactive
  session, the model had no knowledge of the previous messages in the chat.
- Switching model mid-session also appeared to lose all chat history.

## Root cause

`PiRuntime.createSession` (in `src/backend/pi/runtime.ts`) created each
thread's session with:

```ts
SessionManager.create(cwd, sessionDir, { id: threadId })
```

The `{ id }` option on `SessionManager.create` only **names a brand-new
session file** — it does **not** reopen an existing one. `create()` always
flows into `newSession()`, which seeds `fileEntries` with just a session
header (blank) and assigns a fresh `<timestamp>_<threadId>.jsonl` path.

So every time `sessionFor(threadId, cwd)` ran against a thread whose
in-memory `AgentSession` had been evicted (which is **always** after a
backend restart, since the `sessions` Map starts empty), it spawned a
second, empty `<timestamp>_<threadId>.jsonl` and continued the conversation
there. The model received an empty context — no prior turns — even though
the older messages were still on disk in the original file.

`readMessages()` (used to render history in the UI) did the right thing — it
called `SessionManager.list` + `find(id === threadId)` + `open()` — but the
live session used for prompting did not. After the first post-restart turn,
the new file became the most-recently-modified one, so even the displayed
history could fragment.

The "model switch loses history" symptom was the same bug surfacing in a
different scenario: `AgentSession.setModel` is non-destructive (it only
appends a `model_change` entry), but switching model and sending a message
after the app had been reopened triggered `sessionFor` on an evicted
session → blank file → lost context.

## Fix

`createSession` now looks up the thread's existing on-disk session file
(the same lookup `readMessages` uses) and resumes it via
`SessionManager.open(path, sessionDir, cwd)` instead of always creating a
blank one. A new session is only created when no prior file exists.

```ts
const infos = await SessionManager.list(cwd, sessionDir);
const existing = infos.find((info) => info.id === threadId);
const sessionManager = existing
  ? SessionManager.open(existing.path, sessionDir, cwd)
  : SessionManager.create(cwd, sessionDir, { id: threadId });
```

A `try/catch` falls back to `create()` if listing fails (corrupt/locked
session dir), so a turn is never blocked entirely.

## What was built

- `src/backend/pi/runtime.ts` — `createSession` resumes the most recently
  modified matching on-disk session; only creates new ones when none exist.
- `src/backend/test/pi-runtime.test.ts` — regression test
  `PiRuntime.sessionFor resumes the on-disk session after the in-memory
  cache is cleared (restart)`, which fails on the old code and passes on the
  fixed code. It also covers duplicate files by verifying `readMessages` and
  `sessionFor` choose the newest matching session.

## Testing notes

- `npm run typecheck` — clean.
- `npx tsx --test src/backend/test/pi-runtime.test.ts` — 14/14 pass.
- `npx tsx --test src/backend/test/routes-chat.test.ts` — 57/57 pass.
- The new regression test was confirmed to **fail without** the fix and
  **pass with** it.

A manual verification the testing agent may want to run: start the app,
have a chat turn, fully quit/restart the backend, send another message in
the same thread, and confirm the model references prior turns. Also confirm
that switching the model in an existing (reopened) thread preserves context.

## Out of scope / follow-ups

- Pre-existing duplicate `<timestamp>_<threadId>.jsonl` files created by the
  old bug before this fix are not consolidated. After the fix, no new
  duplicates are created; `readMessages` and `sessionFor` both pick the
  most-recently-modified file with the matching id, so behavior is
  consistent. A one-time cleanup/consolidation pass could be added later if
  needed.

## 2026-06-25 update: waiting-for-response session indicator

Built a small status extension for multi-project work: active chat runs now
surface whether their thread is blocked on a pending native `question` tool.
`QuestionBroker` exposes per-thread pending counts, and
`GET /api/chat/active-runs` includes `waitingForResponse` plus
`questionCount` for each active run.

The frontend keeps the existing spinner for active sessions and renders a
filled amber pulsing circle when a session is waiting for user input. This
lets someone working in another project spot that an agent needs an answer,
switch back, respond, and return to their current work.

Testing agent should verify:

- A normally running session still shows the spinning activity marker.
- A session blocked on a native question shows the amber filled marker
  instead of the spinner.
- Answering or cancelling the question clears the waiting marker on the next
  active-run poll.

## 2026-06-26 update: project-switch session isolation

Fixed a regression where switching projects while a chat run was active could
leave the previous project's selected session visible under the newly selected
project. The navigation state now clears the selected thread whenever project
focus moves to a different project, and the app clears the visible task/thread
lists immediately while loading the new project's data.

Also tightened stream detachment semantics: view changes detach the visible
chat stream without aborting the underlying fetch transport or calling the
backend abort endpoint. Explicit Stop still uses the abort path. This prevents
project navigation from turning a healthy in-flight run into a frontend-created
disconnect while the backend still considers the thread busy.

What was built:

- `src/frontend/src/App.tsx` clears stale `activeThreadId`, task lists, and
  thread lists on project changes.
- `src/frontend/src/hooks/usePiStream.ts` makes `detachStream()` non-abortive.
- `src/frontend/src/App.test.tsx` covers switching from a selected session in
  one project to a different project.
- `src/frontend/src/hooks/usePiStream.test.ts` now verifies detach leaves the
  fetch signal open and does not call `/abort`.

Testing agent should verify:

- Start a session run in project A, switch to project B, and confirm the chat
  pane no longer shows project A's session.
- Switch back to project A while the run is still active and confirm the active
  session can be reopened without an "Interrupted" card caused by navigation.
- Press Stop in a running session and confirm explicit cancellation still works.

## 2026-06-26 update: active run history projection

Follow-up testing showed another state mismatch: after navigating away and
back, the sidebar still correctly showed the session as active, but the chat
history card rendered the in-progress run as `Interrupted`. The backend run was
still alive; the history endpoint was reopening JSONL with a `run_start` but no
`run_end` and treating that unfinished persisted segment as terminal.

`GET /api/threads/:threadId` and the legacy `/messages` alias now pass live run
context into `flattenEntries`. Historical unfinished runs still render as
`Interrupted`, but an unfinished run for a currently claimed thread renders as
`running`, and missing tool results inside that active run stay `running` too.

What was built:

- `src/backend/routes/chat.ts` passes active run/thread context when flattening
  session history for the active thread.
- `src/backend/test/routes-chat.test.ts` covers reloading an unfinished active
  run through the real thread history route.

Testing agent should verify:

- Start a long-running session, switch projects, then switch back. The session
  card should still render as running rather than interrupted.
- Once the run completes, refreshing/reopening the same session should show the
  terminal completed/failed/cancelled state from the persisted `run_end`.

## 2026-06-26 update: live re-attachment after project navigation

The previous fixes made the backend run survive navigation (non-aborting
`detachStream`) and made the history card render `running` instead of
`interrupted`. But returning to a still-active session still *looked* frozen:
`ChatPanel` is remounted on project switch (`key={activeProject.id}` in
`App.tsx`), so the new mount's `usePiStream` has no live event feed — the
original NDJSON transport belongs to the unmounted instance even though the
backend `session.prompt()` keeps running. The user saw a static "running"
snapshot with no progress, which read as a hang.

Fix: re-attach by polling. When the loaded history shows a run with
`status === 'running'` and this instance is not itself streaming, the panel
treats the run as active (`attachedRunActive`) — gating the composer, reporting
activity, and polling `GET /api/threads/:threadId` every 1.5s so completed tool
calls and finished assistant turns stream in from the live session file. When
the run reaches a terminal state, polling stops and the composer re-enables.

A second bug was found during testing: `attachedRunActive` originally only
checked `loadedMessages.some((m) => m.run?.status === 'running')`, but
`flattenEntries` only attaches a `run` field to persisted assistant messages.
When a run is still in-flight and the assistant hasn't produced a flushed
message yet (or the message hasn't been written to JSONL), there's **no
message with a `run` field at all** — so `attachedRunActive` was always false,
the polling never started, and the active run was invisible even though the
backend heartbeat proved it was alive. Fix: App.tsx already polls
`/api/chat/active-runs` every 2s and stores the result in
`activeSessionIds` (used by the sidebar for the activity/wait badge). That set
is now passed down to ChatPanel as `backendActiveThreadIds`, and
`attachedRunActive` cross-checks it as a fallback signal so re-attach polling
fires even when the JSONL history doesn't yet show a `running` run card.

Stop needed a parallel path: a locally-started run is cancelled via
`abortStream` (local fetch controller), but a re-attached run has no local
controller. `usePiStream.stopRun(threadId, source)` POSTs to
`/api/threads/:threadId/abort` directly; `ChatPanel.handleStop` picks the right
path based on whether this instance is streaming.

What was built:

- `src/frontend/src/hooks/usePiStream.ts` — `stopRun(threadId, source)` cancels
  a backend-owned run via the explicit `/abort` endpoint without touching local
  reducer state.
- `src/frontend/src/components/ChatPanel.tsx` — `attachedRunActive` derivation
  (checks both loaded history AND `backendActiveThreadIds`), 1.5s history
  polling while a re-attached run is active, combined `isRunning` gating, and
  `handleStop` routing local vs. re-attached cancellation.
- `src/frontend/src/App.tsx` — passes `activeSessionIds` (from the existing
  `/api/chat/active-runs` poll) to ChatPanel as `backendActiveThreadIds`.
- `src/backend/routes/chat.ts` — `[chat-run]` lifecycle instrumentation
  (heartbeat, disconnect-during-run, run start/end, history/active-runs query
  logging) and `GET /api/chat/debug/runs` diagnostic endpoint. Disable with
  `NEXUS_DEBUG_CHAT_RUN=0`.
- `src/frontend/src/hooks/usePiStream.test.ts` — `stopRun` POSTs `/abort`
  without a local stream.
- `src/frontend/src/components/ChatPanel.test.tsx` — re-attach flow: composer
  gated, Stop via `/abort`, composer re-enables once the run completes.

Testing agent should verify:

- Start a long-running task in project A, switch to project B, then switch back
  to A. The session should show live progress (tool calls completing, run phase
  updating) rather than a frozen "running" snapshot.
- The composer stays disabled while the re-attached run is active; Stop cancels
  the backend run and the session resolves to `cancelled`.
- Let the run finish while viewing it: the composer re-enables and the card
  shows the terminal status.
- Stop on a locally-started run still uses the in-process abort path.
