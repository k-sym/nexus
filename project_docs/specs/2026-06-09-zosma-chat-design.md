# Zosma chat in Nexus — design

**Date:** 2026-06-09
**Status:** Draft (pending review)
**Owner:** TBD
**Repo:** `~/Projects/nexus`

## Goal

Replace Nexus's in-house chat (which spawns Claude/Codex/OpenCode CLI subprocesses from Fastify, plus an embedded PTY for "terminal mode" threads) with the chat runtime from `@earendil-works/pi-coding-agent`. After due-diligence review of the upstream `pi` repo, the most efficient integration is to import the SDK in-process (no vendoring, no sidecar subprocess) and use `AgentSessionRuntime` for the multi-thread model.

After this change, Nexus's chat:

- Uses `pi-coding-agent`'s SDK as the runtime (no more `claude --resume`, no more Codex, no more OpenCode-as-CLI; the pi engine drives everything)
- Persists sessions as pi-format JSONL files (tree-structured with `parentId` per entry) under `~/.nexus/sessions/`
- Carries authentication through pi's `AuthStorage` (a single `~/.nexus/auth.json`)
- Lets the user keep multiple chat threads per project, switch between them, and return to a thread with full history, tool-call state, and branching intact (pi's `/tree`-style structure is on disk from day one)
- Warns (and confirms) if the user starts a new chat in a project that already has a thread mid-run
- Has no terminal/PTY mode, no ProvidersSettings page, no Personas system
- Still dispatches Kanban tasks through the orchestrator, which now talks to the pi runtime with a headless prompt; the user picks the model on dispatch

## Non-goals

- Replacing the Electron shell with Tauri.
- Modifying the memory daemon. (A follow-up spec will trim it; see "Future sessions" below.)
- Adding pi's extension store / skill store UI to Nexus. The pi runtime loads its own extensions, but Nexus's UI does not surface them.
- Changing the Kanban board, projects, tasks, scheduler, tickets, or settings (other than the auth section).
- Dropping OpenCode from the user's options. The `opencode-go` provider remains in the model selector because pi's `ModelRegistry` lists it; no separate dispatch path is needed.

## Architecture overview

### Process layout (after the change)

```
┌──────────────────────────────────────────────────────────────┐
│                      Electron shell                          │
│  ┌───────────────────────────────────────────────────────┐   │
│  │              React frontend (Vite)                    │   │
│  │   Sidebar · ChatPanel · ModelSelector · Kanban · …    │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │ HTTP (localhost:4173)              │
│  ┌──────────────────────▼────────────────────────────────┐   │
│  │              Fastify backend (existing)               │   │
│  │                                                       │   │
│  │  Routes ── Orchestrator ── PiRuntime ─────────────┐   │   │
│  └──────────────────────────────────────────────────┬─┘   │   │
│                                                     │ in-process
│  ┌──────────────────────────────────────────────────▼──┐   │
│  │        @earendil-works/pi-coding-agent (npm)         │   │
│  │   AgentSessionRuntime · AuthStorage · ModelRegistry │   │
│  │   SessionManager · session.subscribe()              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         @nexus/memory-daemon  (port 4100)           │    │
│  │         Obsidian vault + index   [unchanged]        │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Why SDK, not sidecar

Pi explicitly supports three integration modes; we use the simplest:

| Mode | When it makes sense | Cost |
|---|---|---|
| **SDK** — `import { createAgentSession }` | App is already Node (Electron / Fastify / etc.) | Lowest. No subprocess, no protocol, no supervisor. |
| **RPC** — `pi --mode rpc` over stdio JSONL | Non-Node host (Tauri Rust, Python, etc.) | Documented JSONL protocol; host spawns a process. |
| **CLI** — interactive / print / json mode | One-shot or human use | Heaviest. |

Nexus is already Node, so we use the SDK. The `SidecarSupervisor` + vendored-sidecar + JSON-line-protocol layer from the earlier draft is dropped. This eliminates ~1500–2000 lines of code that would have been spent on process management.

### Why this preserves "Zosma auth baked in"

The user's earlier requirement was that authentication come from Zosma. The pi runtime is the same engine Zosma wraps, so its `AuthStorage` and `ModelRegistry` are the same code path. The auth *file path* is configurable (`AuthStorage.create(path)`), so we can place it under `~/.nexus/auth.json` — Nexus-namespaced, but functionally identical to what Zosma Cowork sets up.

## Components

### Backend

**New — `src/backend/pi/`:**

| File | Purpose |
|---|---|
| `runtime.ts` | Creates one `AgentSessionRuntime` at boot; owns `AuthStorage` (`~/.nexus/auth.json`), `ModelRegistry`, `SessionManager` (`~/.nexus/sessions/`); exposes typed methods used by routes |
| `events.ts` | Wraps `session.subscribe()` in a per-thread EventEmitter for the route layer |
| `auth.ts` | `saveApiKey`, `startOAuth`, `getAuthStatus`, `logout` thin wrappers around pi's `AuthStorage` + OAuth APIs |
| `sessions.ts` | `listForProject`, `load`, `save`, `delete`; delegates to `SessionManager` where possible, adds Nexus-shaped helpers |
| `lifecycle.ts` | Boot/shutdown integration with Fastify (`fastify.addHook('onClose', ...)`) |

**Deleted:**

- `src/backend/orchestrator/providers.ts` — `runClaudeCode`, `runCodex`, `runOpenCode`, `runOpenAICompatible`, `runPersona`
- `src/backend/orchestrator/stream-adapters.ts` — per-provider NDJSON → `ChatStreamEvent` translator
- `src/backend/chat/` (entirely) — `executor.ts`, `ask.ts`
- `src/backend/pty/` (entirely) — `env.ts`, `launch-command.ts`, `manager.ts`, `node-pty-adapter.ts`, `resolve-launch.ts`, `scrollback.ts`
- `src/backend/routes/pty.ts`
- `src/backend/routes/providers.ts` — including `seedProviders` from `db.ts`
- `src/backend/routes/personas.ts`
- `src/backend/auth/oauth.ts`, `src/backend/auth/store.ts` — replaced by `pi/auth.ts` thin wrappers

**Modified:**

- `src/backend/package.json` — add three direct deps: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` (pinned to latest published versions; `save-exact=true` per pi's supply-chain rules)
- `src/backend/index.ts` — register the pi runtime, drop provider/persona/pty/chat-executor boot
- `src/backend/routes/chat.ts` — rewritten as a thin transport to the pi runtime
- `src/backend/routes/orchestrator.ts` — calls pi for task dispatches (with model picker)
- `src/backend/routes/auth.ts` — thin transport to `pi/auth.ts`
- `src/backend/db.ts` — drop `providers` and `personas` tables; add `chat_threads.zosma_session_id TEXT NOT NULL UNIQUE`; drop `chat_threads.{agent_id, mode, launch_command, agent_session_id}` columns; drop `chat_messages` table
- `src/shared/index.ts` — drop `Persona`, `Provider`, `ProviderKind`, `ChatMode`, `Ask`, `AnswerSet`, `Reply`; simplify `ChatMessage` (no `message_type`, no `structured_json`, no `thinking`/`tool_calls` — those live in the session file); add `ModelInfo`, `ZosmaSessionHeader`

### Frontend

**New:**

- `src/frontend/src/components/ModelSelector.tsx` — ported from Zosma; lists models from `useModels()` hook; uses the `provider/id` key shape
- `src/frontend/src/components/MessageStream.tsx` — visual mirror of Zosma's `ChatMessage.tsx`; renders deltas, thinking, tool-call timeline
- `src/frontend/src/hooks/useModels.ts` — fetches `/api/models`, holds the active model, exposes `setModel(provider, modelId)`
- `src/frontend/src/hooks/useZosmaAuth.ts` — wraps the new auth endpoints
- `src/frontend/src/hooks/usePiStream.ts` — ported from Zosma; reducer that turns `PiEvent`s into renderable state
- `src/frontend/src/components/OrchestratorModelPicker.tsx` — modal invoked when a Kanban task moves to "In Progress"

**Deleted:**

- `src/frontend/src/components/TerminalPane.tsx`
- `src/frontend/src/components/PersonaCard.tsx`
- `src/frontend/src/components/PersonaEditor.tsx`
- `src/frontend/src/components/PersonasPage.tsx`
- `src/frontend/src/components/ProvidersSettings.tsx`
- `src/frontend/src/components/OpenCodeModelsView.tsx` (folded into the model selector; OpenCode models still appear via `opencode-go` in the selector list)
- `src/frontend/src/components/NewChatPicker.tsx` (replaced by a simple "+ New chat" with model picker)
- `src/frontend/src/components/QuestionCard.tsx` (replaced by listening to pi's `ui_request` events for extension UI dialogs)

**Modified:**

- `src/frontend/src/App.tsx` — drop `activeThreadAgentSlug`, `newChat` flow, `terminal` mode, persona references; add `useModels`, `useZosmaAuth`
- `src/frontend/src/components/Sidebar.tsx` — drop terminal-mode icon, drop "OpenCode models" view entry
- `src/frontend/src/components/ChatPanel.tsx` — full rewrite using the pi runtime event stream; preserves drop-zone/file upload via `POST /api/threads/:threadId/upload`
- `src/frontend/src/components/SettingsPage.tsx` — add Zosma auth section; remove API key / provider model fields
- `src/frontend/src/components/KanbanBoard.tsx` — no UI change; "move to In Progress" flow triggers a model-picker dialog
- `src/frontend/src/api.ts` — trim chat (returns pi-shaped events), drop pty/providers/personas, add models + auth

## Data flow

### Sending a message in a thread

```
ChatPanel                Fastify                    PiRuntime
   │                       │                            │
   │ POST /api/threads/X/  │                            │
   │ messages/stream       │                            │
   ├──────────────────────▶│                            │
   │                       │  runtime.sessionFor(X)     │
   │                       │     .prompt(text)          │
   │                       ├───────────────────────────▶│
   │                       │                            │ pi-mono.prompt()
   │                       │  session.subscribe() → ... │
   │                       │◀───────────────────────────┤
   │   NDJSON: {kind:event, │                            │
   │            event:...} │                            │
   │◀──────────────────────┤                            │
   │   NDJSON: {kind:done, │                            │
   │            message}   │                            │
   │◀──────────────────────┤                            │
```

ChatPanel's reducer mirrors Zosma's `usePiStream`: it accumulates deltas into a single streaming bubble, joins `tool_execution_start/update/end` into the same assistant message's `toolCalls` array, and on `done` appends the finalized message to visible history. A subsequent `GET /api/threads/:threadId` returns the canonical state from the session file.

### Switching threads mid-run (same project)

1. User clicks thread B in Sidebar
2. ChatPanel for A unmounts; the in-flight HTTP stream continues (Fastify keeps it open) but no longer has a client
3. ChatPanel for B mounts with messages from `GET /api/threads/B`
4. User submits in B
5. Fastify checks `runs.get(projectId)` — finds A's run is still active
6. Returns 409 with `{ activeThreadId: A, activeTitle }`
7. ChatPanel shows confirm dialog: "Thread X is still running. Start this one anyway (will cancel X)?"
8. On confirm, frontend retries with `X-Confirm-Cancel: true`
9. Fastify: `runtime.sessionFor(A).abort()` → wait ≤200ms for `done`/`error` → clear `runs[projectId]` → proceed with B's prompt

### Switching projects

Switching projects doesn't change the pi session's cwd immediately. The next prompt in the new project does `runtime.sessionFor(thread, { cwd: newProject.repo_path })` before invoking `prompt`. Sessions are cheap; the runtime reuses the same `AuthStorage` + `ModelRegistry`.

### Orchestrator dispatch (Kanban)

When a task moves to "In Progress":

1. Orchestrator pushes an `orchestrator:ask-model` event to the frontend via SSE
2. Frontend renders a "Pick a model for this task" modal listing the pi runtime's available models
3. User picks; frontend `POST /api/orchestrator/tasks/:id/start` with `{ modelKey: "anthropic/claude-sonnet-4-5" }`
4. Orchestrator:
   - Stores `task.model_key` on the task row
   - Calls `runtime.setModel(modelKey)` (no-op if already current)
   - Calls `runtime.newHeadlessSession({ cwd: project.repo_path })` (fresh session per task; no UI bridge)
   - Calls `session.prompt(taskContext)` and subscribes to events
   - On `done`, writes the final assistant text to `project_docs/outputs/{taskId}.md`, updates `agent_runs`, moves task to "review" (or "triage" on error)

The orchestrator reuses the existing `agent_runs` table for token-usage tracking. The `Usage` page keeps working.

## Data model

### `chat_threads` (after migration)

```sql
CREATE TABLE chat_threads (
  id                TEXT PRIMARY KEY,        -- also used as the pi session id
  project_id        TEXT NOT NULL,
  title             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  archived_at       TEXT,
  zosma_session_id  TEXT NOT NULL UNIQUE     -- equals id; kept for forward-compat
);
```

Dropped columns: `agent_id`, `mode`, `launch_command`, `agent_session_id`. Dropped table: `chat_messages` (its content lives in the session file). Dropped tables: `providers`, `personas`.

### Session file format (pi tree format)

```
{"type":"session","version":1,"title":"...","createdAt":...,"model":"...","provider":"...","cwd":"...","messageCount":N}
{"id":"m1","parentId":null,"role":"user","content":"...","timestamp":...}
{"id":"m2","parentId":"m1","role":"assistant","content":"...","thinking":"...","toolCalls":[...],"model":"...","provider":"...","timestamp":...}
{"id":"m3","parentId":"m2","role":"toolResult","toolCallId":"...","toolName":"...","content":[...],"isError":false,"timestamp":...}
...
```

Stored at `~/.nexus/sessions/{cwd-slug}/{threadId}.jsonl`. The `parentId` chain unlocks in-place branching (pi's `/tree`) and compaction in future UI without a re-migration.

## Data migration

A one-time script `scripts/migrate-chats-to-zosma.cjs`:

1. For each row in `chat_threads` where `archived_at IS NULL`:
   - Look up the project's `repo_path`
   - Load all `chat_messages` ordered by `created_at`
   - Translate each row into a pi tree-format message line, chaining `parentId` from the previous entry (so a flat conversation becomes a single-branch tree)
   - Build the session header (use thread title; default model from the first assistant message; `cwd = project.repo_path`)
   - Write `~/.nexus/sessions/{cwd-slug}/{threadId}.jsonl`
2. Migrate the schema (gated on a `user_version` bump in SQLite):
   - Add `zosma_session_id` column to `chat_threads`
   - Drop `agent_id`, `mode`, `launch_command`, `agent_session_id`
   - Drop `chat_messages` table
   - Drop `providers`, `personas` tables
3. Print a summary: threads migrated, sessions written, any threads skipped (and why)

The script is idempotent: re-running it overwrites session files and is a no-op for already-migrated rows.

Backwards-compat: for one release, the chat panel tolerates `chat_messages` still existing by falling back to it if the session file is missing. The fallback path is removed in the release after.

## Per-project concurrency

The pi runtime serializes prompts at the runtime level (its internal prompt-scheduler). To surface conflicts honestly at the *project* level (the user's mental model), Fastify keeps an in-memory `Map<projectId, threadId>` of "active runs":

- Registered when a stream starts
- Cleared when the pi runtime emits `done` or `error`
- Checked at the start of every `POST /api/threads/:id/messages/stream`
- 409 returned if the project already has an active run; `X-Confirm-Cancel: true` header on retry triggers `runtime.sessionFor(activeThreadId).abort()` then proceeds

In-memory state is lost on backend restart. After a restart, the next prompt in a project proceeds (no false conflict warning). The orphan run completes in the background; its result is in the session file but not surfaced live. Acceptable: the user's last visible action is what they expect to see.

## Error handling

| Failure | Behavior |
|---|---|
| pi runtime dies (unhandled exception) | Backend logs, returns 503 for the in-flight request. The next request re-creates the session lazily. |
| Auth not configured | `GET /api/auth/has-credentials` returns `false`. Settings page shows a banner; chat panel shows "Sign in to Zosma" with a button. |
| pi runtime emits `error` event | Forwarded as `{kind:"error",error:msg}` to the active stream. UI surfaces it in the streaming bubble. |
| Network drop on streaming HTTP | Last canonical state lives in the session file; user reloads thread. |
| OAuth browser never opens (e.g. headless) | `startOAuth` returns `{ok:false,reason:"no_browser"}`; UI shows a "Copy URL" button. |
| Concurrent run in a project | 409 as described above. |
| Orchestrator headless prompt fails | Task moves to "triage"; error logged in `agent_runs`. |

## Testing

### Unit (Vitest)

- `pi/runtime.test.ts` — happy path: create runtime, mint session, prompt, verify event stream
- `pi/sessions.test.ts` — `listForProject`, `load`, `save`, `delete` against a temp home dir
- `pi/auth.test.ts` — `saveApiKey`, `getAuthStatus`, `logout` round-trips
- `usePiStream.test.ts` — ported from Zosma; reducer produces the right state for the agent event stream
- `routes/chat.test.ts` — with a mock pi runtime: stream endpoint returns events; concurrent run returns 409; abort path works
- `migrate-chats-to-zosma.test.ts` — round-trip: write fixture DB + messages, run migration, verify session file content and parentId chain

### Integration

- `tests/integration/pi-e2e.test.ts` — spawns the Fastify backend with a real pi runtime, runs a tiny prompt against a stub provider (echoes the prompt), verifies events arrive and a session file is written

### Manual verification checklist

- Onboard a new project; create a thread; send a message; verify streaming
- Switch to a second thread; send; verify both thread histories persist when revisited
- Start a long prompt; while running, start a second prompt in another thread; verify confirm dialog
- Restart the backend; verify chat threads still load (sessions are on disk)
- Open Settings; sign in to Zosma with an API key; verify a new model appears in the selector
- Move a Kanban task to In Progress; verify model-picker; verify the task moves to Review on success
- Delete a thread; verify the session file is gone
- Sign in to `opencode-go` with an API key; verify the curated OpenCode model list (e.g. `glm-4.6`) appears in the selector

## Future sessions

### Trim the Nexus memory daemon

**Premise:** With chat owned by pi, the daemon's in-session value is largely absorbed by the pi runtime; its remaining value is cross-project recall and project-doc indexing. The 3 local llama servers (gen :4001, embed :4002, rerank :4003) are the obvious dead weight — provider-backed embeddings replace them cleanly.

**Why defer:** Chat work does not depend on the daemon trim, and the daemon trim does not depend on the chat work. Ship chat first; trim memory in a focused follow-up.

**Goals for the follow-up session:**

1. **Write path stays untouched.** Chat turns continue to be written as markdown to the Obsidian vault — this is canonical and must not regress.
2. **Drop the 3 local llama servers.** Replace embedding generation with calls to whichever provider the user has already authenticated in `~/.nexus/auth.json` (reuse the same auth the chat runtime uses). Rerank and standalone generation are dropped — FTS5 + provider embeddings cover recall; in-session generation is the pi runtime's job.
3. **Keep cross-project recall.** A single SQLite-vec index over the Obsidian vault (no knowledge graph, no separate MCP daemon) with an HTTP endpoint that the pi runtime's session-start hook can query to inject relevant notes.
4. **Keep project-doc indexing.** Index `project_docs/AGENTS.md`, specs, plans, and uploads so the agent can recall them across sessions.
5. **Drop the MCP server** if no external consumer exists at the time of the follow-up. Re-add it only when an external client (CLI agent, script, second app) actually needs it.

**What the follow-up spec will need to address:**

- The daemon's HTTP surface shrinks from the current set to just `POST /recall` (query → top-k chunks) and `POST /index` (reindex trigger)
- The auto-injection hook on chat start (today: `getRelevantMemories` in the daemon) becomes a pi extension or session-start callback in the Fastify backend
- The 48-hour chat archival sweep (orchestrator) is replaced by a `session.subscribe()` hook that copies the last turn into the vault
- The `nexus-memory` recall-only skill is replaced or re-pointed at the new lightweight endpoint
- Migration: existing SQLite index is rebuilt under the new shape (no data loss; Obsidian vault itself is unchanged)

**Re-evaluation triggers (when to do this session):**

- A user reports the 3 local llama servers are too heavy to run on their machine
- Cross-project recall becomes a noticeable gap during normal use
- The MCP server is no longer consumed by anything (then drop it without ceremony)
- A pi extension reaches feature parity with the daemon's recall (then the daemon can be deleted entirely, not just trimmed)

## Open questions

- Do we want a UI for pi's `/tree` branching? Defer; the on-disk format supports it for free.
- Chat memory: the legacy orchestrator wrote to the memory daemon after each chat turn. With chat owned by pi, the hook is `session.subscribe()` writing to the daemon — but the daemon itself is targeted for trimming (see "Future sessions"). Decision: keep the legacy hook working against the existing daemon in this spec (no behavior change for users); revisit in the memory-trim follow-up.
- Should `chat_threads.zosma_session_id` always equal `id` (and we drop the column), or do we want a future where the same thread can be backed by different session files (e.g. forking)? Lean: keep the column equal to `id` for now; drop in a later migration if we never use it.
