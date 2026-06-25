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

- `src/backend/pi/runtime.ts` — `createSession` resumes existing on-disk
  sessions; only creates new ones when none exist.
- `src/backend/test/pi-runtime.test.ts` — regression test
  `PiRuntime.sessionFor resumes the on-disk session after the in-memory
  cache is cleared (restart)`, which fails on the old code and passes on the
  fixed code.

## Testing notes

- `npm run typecheck` — clean.
- `npx tsx --test src/backend/test/pi-runtime.test.ts` — 13/13 pass.
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
