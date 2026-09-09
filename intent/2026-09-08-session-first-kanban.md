# Intent: Session-first Kanban
Author: Keith. Status: accepted. Source: conversation (interview, 2026-09-08), follow-on to Ticket to session (#432). Issue: #439.

## Problem
The Kanban board has gone stale on three counts. Tasks are a parallel object to
sessions, so the board does not show where the agents actually are. GitHub triage
fills Triage with every open issue and nothing moves (baker-pro: 79 tasks, 77 of
them GitHub issues in Triage, 3 with a chat). The five hand-moved columns no longer
match how work flows: since #432 a ticket becomes a session directly, and the
same should be true of everything else on the board.

## Proposed outcome
The board is a view over a project's sessions and their origins. Cards are chat
threads, each showing its origin (GitHub issue, Monday item, Jira ticket, or plain
chat). Lanes are derived from live state and cannot be dragged: Inbox, Running,
Needs you, Idle, Done. Inbox lists the project's open GitHub issues and Monday
items that have no session yet; clicking one runs the Tickets flow (Draft with
Sonnet, project, model, branch, prompt, Go) and Go opens a session stamped with
the origin. Nothing is parked on the board: the + button sends you to Ideas, and
graduated ideas arrive in the Inbox as issues. Web and iOS together.

## Affected users and systems
Keith only. Backend (baker-pro, launchd): additive origin columns on `chat_threads`,
a board route, an origin-to-session route reusing the ticket draft module, Monday
links re-pointed from tasks to threads. Web KanbanBoard and App wiring; iOS
KanbanBoardView, TaskEditSheet and NexusCore (simulator build is Keith's).

## Constraints
- Tickets, the Jira poll and the next-message suggestion (#432, #434) are untouched.
- No new write to GitHub, Monday or Jira; nothing new reachable from agent tools.
- Migrations additive; `tasks` and `task_monday_links` stay as tombstones. The
  two hand-made tasks are re-filed as ideas by Keith, not migrated.
- Monday roll-up and status write-back keep working: derived lanes map onto the
  existing five statuses (Inbox=triage, Running/Needs you=in_progress,
  Idle=review, Done=deploy) so the Monday config and guards do not change.
- Diff review keeps the action that seeds the current session; the actions that
  create task rows go.
- Proof: tests, typecheck and simulator build green; on baker-pro, Go on a real
  GitHub issue, thread stamped with the issue number, run aborted within seconds,
  checkout restored, screenshots before and after.

## Open questions
- None; decisions above came out of the interview and the approved brief.
