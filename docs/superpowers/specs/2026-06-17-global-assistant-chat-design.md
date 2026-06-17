# Design: Global Assistant chat

## Goal

Add a project-independent **Assistant** tab to Nexus so the user can chat with a remote assistant service such as Hermes or OpenClaw. The assistant is intended for work that can continue outside the Nexus app lifecycle, so it must not be modeled as a project task, project session, or scheduler replacement inside Nexus.

## User Experience

The top bar gets a new **Assistant** global tab alongside Dashboard, Tickets, and Braindump. Selecting it opens a full-height chat surface with a normal message history, composer, send button, and stop button. The view does not show the project header, model selector, memory rail, or project session sidebar controls.

If Assistant configuration is incomplete, the chat view remains available but clearly reports that the Assistant URL and key must be configured in Settings.

Settings gains an **Assistant** section with:

- Assistant URL
- Key

The key is stored through the existing settings/config path and can also be supplied through `ASSISTANT_API_KEY`. Secrets should not be hard-coded into source files.

## Architecture

Assistant chat uses a dedicated backend API namespace:

- `GET /api/assistant/thread`
- `POST /api/assistant/messages/stream`
- `POST /api/assistant/abort`

The frontend uses a small Assistant-specific stream hook instead of forcing the project chat hook to handle global state. The message rendering can share UI conventions with `ChatPanel`, but Assistant remains separate from `chat_threads`, tasks, and projects.

The backend stores the single global conversation in an Assistant-specific persistence surface. A single global thread is enough for this release; named Assistant sessions can be added later without changing the top-level navigation concept.

## Data Flow

1. The user opens the Assistant tab.
2. The frontend loads the persisted Assistant thread from `/api/assistant/thread`.
3. The user sends a message to `/api/assistant/messages/stream`.
4. The backend validates Assistant URL/key configuration, stores the user message, forwards the turn to the configured remote Assistant endpoint, streams response events back to the UI, and stores the assistant response.
5. The frontend appends streaming deltas and reloads persisted messages after completion.

## Configuration

`NexusConfig` gains:

```ts
assistant: {
  url: string;
  api_key: string;
}
```

Defaults:

- `url`: empty string
- `api_key`: `${ASSISTANT_API_KEY}`

At runtime, the backend resolves `${ASSISTANT_API_KEY}` the same way existing config secrets are resolved.

## Error Handling

Missing URL or key returns a clear 400-level response. Network or provider failures return a readable error without losing the user's draft. Abort requests should cancel the current in-process Assistant stream when one is active.

## Testing

Backend tests cover:

- Settings/config exposes Assistant fields.
- Missing Assistant URL/key returns a clear error.
- Assistant thread messages load independently of project chat threads.

Frontend tests cover:

- TopBar renders the Assistant tab and selecting it opens the Assistant view.
- Assistant view does not require an active project.
- Missing configuration error is shown in the chat surface.
