# Sessions Navigation and Scheduler Removal Design

## Goal
Update Nexus terminology from chat-centric language to session-centric language, add a sidebar indicator for active session work, and remove the built-in Scheduler because cron jobs are handled outside Nexus.

## Scope
- Rename visible UI labels from Chat/Chats/New Chat to Session/Sessions/New Session where they refer to conversational threads.
- Keep internal database and API names such as `chat_threads` and `/api/threads` unless changing them is required for user-visible behavior.
- Add a left-nav activity indicator for sessions currently streaming, thinking, responding, or using tools.
- Remove Scheduler user-facing views, command palette entry, settings section, routes, backend startup loop, and shared config surface.
- Keep Jira polling intact. Jira uses `src/backend/jira/poll.ts` and `jira.poll_minutes`; it does not depend on `src/backend/scheduler`.
- Do not add Git status in this pass because there is no backend Git status API today.

## Architecture
`App` remains the navigation coordinator. `ChatPanel` will report session activity upward via a callback, and `Sidebar` will receive a set of active session IDs to render a spinner beside busy session rows. Scheduler removal is surgical: delete unused Scheduler UI/backend files and remove imports, routes, top-bar links, command palette entries, config references, and README references that describe the built-in scheduler.

## Testing
- Add reducer tests for the new session activity state in `App` if the existing frontend test setup supports it, or add targeted component tests around `Sidebar` rendering if available.
- Run TypeScript typechecks for shared, backend, and frontend.
- Run backend tests that cover Jira polling to verify Scheduler removal does not affect Jira.
