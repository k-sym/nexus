# Design: Session archive to memory

## Goal

Add an explicit **Archive** action for project sessions. Delete remains a throw-away action: it removes a session without creating memory. Archive is the memory-preserving action: it summarizes the session into project memory, then removes the session from the Sessions list.

## User Experience

Each session row gains an archive/file-box icon next to the existing rename and delete actions. The icon is only shown with the other hover actions to keep the sidebar compact.

Clicking archive asks for confirmation:

```text
Archive this session to memory and delete it?
```

After confirmation, Nexus summarizes the chat history, writes the summary into the project's memory system, deletes the session, and refreshes the Sessions list. If the archived session is currently open, the main chat panel returns to the no-session state.

Delete keeps its current behavior and wording. It does not summarize or write memory.

## Architecture

The backend owns the archive workflow behind the existing thread route surface:

- `POST /api/threads/:threadId/archive`

That endpoint becomes the full archive operation instead of only setting `archived_at`.

The archive operation is implemented as a backend service so the workflow is atomic from the frontend's point of view:

1. Load the thread and its project.
2. Read the session history from pi using `pi.readMessages(threadId, project.repo_path)`.
3. Fall back to persisted `chat_messages` if the pi session file is missing or empty.
4. Convert the conversation into a compact transcript.
5. Ask the configured local OpenAI-compatible generation endpoint to summarize the session for long-term memory.
6. Store the summary through the existing memory facade.
7. Delete the thread row and drop the pi session files.

The service should share extraction helpers with the existing task-chat summarizer where practical, but session archive has its own prompt and category because it is not tied to a task status change.

The local summarizer uses `models.local.base_url` from Nexus config, which defaults to `http://127.0.0.1:4001/v1`. It sends a one-shot `/chat/completions` request to the running local model with a low-temperature, memory-focused system prompt. If the local endpoint is unavailable or returns an empty summary, archive fails and the session is kept.

## Memory Output

Archive writes one project memory with:

- `category`: `session_archive`
- `agent_id`: `session-archive`
- `content`: the model-generated summary
- metadata including the archived thread id, thread title, and source `session-archive`

The summary should emphasize durable information: decisions, constraints, implementation notes, discoveries, user preferences, and follow-up context. It should avoid chat filler, transient status messages, and duplicated transcript.

## Failure Handling

Archive must not delete the session unless memory has been written successfully.

Failure cases:

- Missing thread: return 404.
- Missing project: return 404.
- No meaningful chat history: return a clear 400-level error and keep the session.
- Local model summarization failure: return an error and keep the session.
- Memory write failure: return an error and keep the session.

This preserves the difference between archive and delete: archive is allowed to fail because losing the source session without memory would violate the feature's purpose.

## Frontend

The frontend API client gains an archive method for threads. `App` gets a handler that calls archive, clears `activeThreadId` when needed, and reloads threads for the active project.

`Sidebar` gets:

- an archive/file-box icon in the session row hover actions
- a new `onArchiveThread` prop
- click handling that stops row selection, confirms the destructive memory-preserving action, and invokes the handler

The row can show a minimal in-progress state while archiving if the existing component structure supports it cleanly. The critical behavior is that the action is not confused with delete.

## Testing

Backend tests cover:

- successful archive stores memory and deletes the thread
- summarization or memory failure does not delete the thread
- empty/no meaningful chat history returns an error and keeps the thread
- delete still removes the thread without storing memory

Frontend tests cover:

- the archive action appears with session actions
- clicking archive confirms and calls the archive handler
- delete still calls the delete handler and does not call archive
