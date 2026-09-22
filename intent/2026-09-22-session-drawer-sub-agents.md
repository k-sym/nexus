# Session drawer with a Sub-agents tab
Date: 2026-09-22
Status: accepted — Keith asked for it in chat 2026-09-22
Author: Keith (captured by Claude)
Source: chat request, "right hand 'drawers' in the project chat sessions"

## Problem

A project chat session has two right-hand rails today: the project's recent memories (always
available) and a file preview (opens when a path in chat is clicked). Role child runs — Scout,
Researcher, Builder, Refuter, Debugger — are visible only inline under the delegating tool call,
buried in the transcript once the parent moves on. Debugging a sub-agent means scrolling back to
find its block, and there is no place that lists every child of the session with its timing and
outcome.

## Proposed outcome

One drawer on the right of a session, with three tabs at the top: **Memory**, **Preview** and
**Sub-agents**. Memory and Preview keep what they do today. Sub-agents lists every role child run
of the open session, newest first — role, model, status, tokens, duration — and expands a row into
its ledger identity (child run id, parent run id, delegating tool call id, started and finished
times), the reason it stopped when it did not complete, its report and its retained tool timeline,
refreshed live while a child is running. Clicking a path in chat still opens the Preview tab. The
drawer's open state and chosen tab persist.

## Affected users and systems

Keith, on the desktop web UI. Backend: one new read route, `GET /api/threads/:threadId/runs`,
over the existing `role_runs` ledger. iOS and the glasses are untouched.

## Constraints

- No new configuration. No new writes; the drawer only reads the ledger and the existing
  `GET /api/runs/:id/events`.
- Child approvals keep their home inside the chat's role block; the drawer must not claim the
  approval slot, or a pending gate would move out of the transcript.
- Polling stays cheap: only the active tab fetches, and the Sub-agents tab polls faster only while
  the session or a child is running.

## Open questions

None at capture. A running-child count badge on the Sub-agents tab was left for later so the
drawer does not have to poll while another tab is showing.
