# Intent: Claude Desktop session handoff
Author: Keith. Status: accepted. Source: conversation 2026-09-12/13 (Claude engine now runs on the Claude Agent SDK).

## Problem
A Claude-engine thread in Nexus and a Claude Desktop (Code tab) session are the same kind of thing on disk, one SDK transcript under `~/.claude/projects/<cwd-slug>/<id>.jsonl` on baker-pro, but neither side can see or continue the other. Work started in Nexus cannot be picked up in the desktop app, and desktop sessions cannot be brought onto the board.

## Proposed outcome
Two actions. "Open in Claude Desktop" on a Claude-engine thread hands the session id to the desktop app (its `claude://resume?session=<id>` import hook); the thread stays live in Nexus on the same id, and turns made in the desktop appear in Nexus the next time the thread is opened or a turn is sent. "Import from Claude Desktop" lists desktop sessions for the current project's repo path and creates a Nexus thread that continues that session with full context. Neither action deletes or duplicates a transcript.

## Affected users and systems
Keith on baker-pro. Nexus backend (Claude engine, thread routes, transcript reconciliation), web dashboard, iOS thin client (both actions; the open action fires on baker-pro). Reads `~/.claude/projects` and the desktop's session index; the only write to the desktop app is the deep link. Settings: one status row on the Claude engine card saying whether the desktop app and its session index were found; no new config keys.

## Constraints
- One session id, both sides live (Keith's decision). Nexus re-reads the SDK transcript on open and before a turn to show desktop turns; no file watching in this cut.
- Dropping or archiving a thread whose session has been handed off or imported must leave the SDK transcript alone; today `ClaudeEngine.dropSession` deletes it.
- Import lists sessions for existing Nexus projects only; no project creation from a session's cwd.
- Pi-shaped JSONL stays the frontend/iOS contract; imported turns are converted into it, not rendered from a second format.
- The desktop's own "resume CLI session" picker hides SDK-created sessions, so the deep link is the handoff path; verify it accepts an `sdk-ts` session before building on it.
- A thread that has been opened in the desktop shows a badge in Nexus.
- Proof of done is a live walk on baker-pro: hand off a real thread, continue it in the desktop, see that turn in Nexus, then import a real desktop session and send a turn. iOS is eyeballed after merge.
- Glasses out of scope. No Monday/GitHub/Jira writes involved.

## Open questions
None blocking; both answered in the conversation on 2026-09-13.
