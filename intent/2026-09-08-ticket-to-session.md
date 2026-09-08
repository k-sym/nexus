# Intent: Ticket to session
Author: Keith. Status: accepted. Source: conversation (interview, 2026-09-08). Issue: #TBD.

## Problem
The Jira ticket list and status sync in Tickets work well. Everything after the
click does not: the sidebar only offers "create a Kanban task", and the ticket
body is Jira bloat (forwarded mail, signatures, disclaimers) that hides the one
line that is the actual issue. Keith reads the ticket in Jira and hand-writes
the opening prompt for a session every time, on the laptop or the phone.

## Proposed outcome
Click a ticket on web or iOS, and Nexus drafts the real problem out of it with
Sonnet: a distilled problem statement, a suggested project, a branch type
(fix / hotfix / feature) and a branch name in SSUK's form
`fix/SUP123-scoring-last-score-missing`. Keith picks the project and a model
from the curated list, edits the prompt and branch, presses Go, and lands in a
new session in that project whose first turn is the edited prompt. The session
replaces the Kanban task. Tickets that have a session show a badge linking to it.

## Affected users and systems
Keith only. Backend (baker-pro, launchd): two new ticket routes, one new
config key for the drafting model, one additive column on `chat_threads`.
Web Tickets sidebar. iOS Tickets list and a new ticket detail screen
(NexusCore models + App target; simulator build is Keith's).

## Constraints
- Jira is never written to. Keith closes tickets in Jira himself.
- Kanban, tasks, and the GitHub issue triage sync are untouched; Kanban gets its
  own rework in a separate session.
- The poll loop, JQL, content rules and notifications stay as they are.
- Drafting runs through the Claude Agent SDK engine (subscription harness),
  tools off. Ticket text therefore leaves the machine to Anthropic; accepted.
- The prompt sent as turn one carries a fixed trailer: work on the named branch,
  push it when done, do not touch Jira.
- Migration additive only. Any write to an external system stays confirm-gated
  (there is none here beyond the session's own agent work).

## Open questions
- Follow-on, not this build: should the composer's next-message suggestion
  default to Sonnet through the same engine instead of the local model?
