# Assistant agent parity — design

**Date:** 2026-07-02
**Status:** Approved (design)
**Branch:** `feature/assistant-agent-parity`

## Problem

The Assistant renders every agent turn as plain text. Its stream carries only
`run_start` / `text_delta` / `complete` / `error` because the backend *polls*
Hermes for a run's final output (`startRun` → `getRun`) instead of consuming
Hermes's structured event stream. So there is no tool transparency, no thinking,
and only a coarse header status — unlike the Projects chat, which shows live tool
calls, thinking, a consolidated status strip, and collapsible tool detail.

Hermes is an OpenAI-compatible agent server whose `/v1/responses` endpoint
surfaces tool calls as distinct structured events (`function_call` /
`function_call_output`) and streams them. The data exists; the Nexus backend
just doesn't consume it.

## Goal

Bring Projects-chat-grade agent-run transparency to the Assistant's **foreground
streamed** turns — live tool calls, thinking, consolidated status, collapsible
tool detail — by consuming Hermes `/v1/responses` streaming and feeding the
existing, already-generic run-state model and shared components.

## Key enabler: the run-state model is provider-agnostic

`AgentRunView`, `AgentToolView`, and `agentRunReducer`
(`src/frontend/src/chat/agent-run-state.ts`) have **no pi coupling**. They are a
generic run/tool/phase state machine driven by a fixed action vocabulary
(`RUN_STARTED`, `MODEL_RESPONDING`, `TOOL_QUEUED`, `TOOL_STARTED`, `TOOL_OUTPUT`,
`TOOL_FINISHED`, `RUN_ENDED`, `RUN_INTERRUPTED`). `AgentRunCard`, `ToolActivity`,
and `RunStatusStrip` render directly from `AgentRunView`. Therefore the Assistant
can reuse all of it; the entire task is **feeding the reducer the right events**.

## Decisions (from brainstorming)

- **Endpoint:** consume `POST /v1/responses` with `stream: true`.
- **Reload:** live runs are fully rich; reopening a past session shows final text
  as today. Persisting/replaying structured runs is a follow-up.
- **Status UI:** adopt the Projects-style `RunStatusStrip` above the Assistant
  composer + Stop in the composer while running.
- **Background/remote handoff runs:** keep the current coarse status; no rich
  tool history this pass.

## Architecture — three layers, one translation seam

### 1. Backend translation layer (the core work)

`streamSessionTurn` (`src/backend/routes/assistant.ts`) stops polling and instead
consumes a live Hermes `/v1/responses` stream, translating each OpenAI Responses
event into the **same NDJSON event vocabulary the Projects chat backend already
emits** (`src/backend/routes/chat.ts`). Downstream code never learns it is Hermes.

New `HermesClient` method (`src/backend/hermes/client.ts`):

```
streamResponses(input: HermesResponsesInput): AsyncIterable<HermesResponseEvent>
```

- Request: `POST {base}/v1/responses`, body `{ input, stream: true, ... }`,
  headers `Authorization: Bearer {key}` + `X-Hermes-Session-Key:
  nexus:assistant:{session.id}`; session continuity via
  `session.remote_session_id ?? session.id` (unchanged from today).
- Parses SSE lines (`data: {...}`) into typed `HermesResponseEvent`s and yields
  them; stops on `data: [DONE]` / `response.completed`.

**Responses event → Nexus NDJSON event mapping** (emitted by `streamSessionTurn`):

| Hermes `/v1/responses` SSE event | Nexus NDJSON event emitted |
|---|---|
| `response.created` | `{ type: 'run_start', runId, remoteRunId? }` (+ `provider`/`model` if present) |
| `response.output_text.delta` `{ delta }` | `{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }` |
| `response.reasoning_summary_text.delta` / reasoning delta `{ delta }` | `{ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } }` |
| `response.output_item.done` where item.type === `function_call` `{ id, name, arguments }` | `{ type: 'tool_execution_start', toolCallId: id, toolName: name, args }` |
| output item of type `function_call_output` `{ call_id, output, is_error? }` | `{ type: 'tool_execution_end', toolCallId: call_id, toolName, result: { content: [{ type:'text', text: output }] }, isError: !!is_error }` |
| `response.completed` | `{ type: 'run_end', run: { runId, completedAt, status: 'completed' } }` |
| `response.failed` / `response.incomplete` `{ error }` | `{ type: 'run_end', run: { runId, completedAt, status: 'failed', error } }` |
| stream/transport error | `{ type: 'error', error }` |

Notes:
- `tool_execution_start` immediately followed by `tool_execution_end` (Hermes
  executes tools server-side; we surface queued→running→finished from the two
  events). Streaming partial tool output (`tool_execution_update` → `TOOL_OUTPUT`)
  is optional and only emitted if Hermes streams intermediate output; absence is
  fine.
- **Reducer upsert (resolve in Task 1):** in the pi flow, `tool_execution_start`
  (→ `TOOL_STARTED`) is always preceded by a `TOOL_QUEUED` (from a `toolcall_end`
  message_update), so the tool already exists. The Assistant emits
  `tool_execution_start` with **no** prior queued event. Confirm `agentRunReducer`
  treats `TOOL_STARTED` as an upsert (creates the tool if absent); if it does not,
  make it upsert. This is a reducer robustness fix — safe for pi (which always has
  a prior queued tool) and it keeps the shared event→action mapping identical for
  both sources, so the `usePiStream` refactor stays behavior-preserving.
- Argument streaming (`response.function_call_arguments.delta`) may be buffered
  and only emitted on `output_item.done` — we do not need per-delta arg
  streaming for parity.
- **Abort** keeps the existing path: reader cancel + `hermes.stopRun`, then the
  route emits `{ type: 'run_end', run: { status: 'cancelled', abortSource:
  'user' } }`.

Config selection: if `/v1/capabilities` (or config) indicates `/v1/responses`
streaming is unavailable, fall back to the current poll-then-`text_delta`
behavior (graceful degradation — the frontend renders it as a plain text run).

### 2. Frontend — feed the shared reducer

- **New shared module** `src/frontend/src/chat/agent-run-events.ts`: a pure
  function `agentRunActionsFor(event): AgentRunAction[]` that maps one Nexus
  NDJSON event to the `agentRunReducer` action(s) it implies (the run/tool/phase
  part of the mapping currently inline in `usePiStream`'s `routeEvent`).
  `usePiStream` is refactored to call this helper (behavior-preserving; guarded
  by its existing Projects tests), so there is **one** event→action mapping.
- **`useAssistantStream`** consumes the structured NDJSON. Per turn it:
  - builds an `AgentRunView` via `agentRunReducer` fed by `agentRunActionsFor`,
  - accumulates `text_delta` into the streaming message's `content` and
    `thinking_delta` into a new `thinking` field,
  - attaches the `AgentRunView` to the streaming assistant message as `run`.
  - Unknown event types are ignored (forward-compatible). If a turn produces no
    structured run (e.g. capability fallback), `run` stays undefined and the
    message renders as plain text exactly like today.
- **Type changes** (`useAssistantStream.ts`): `AssistantMessage` gains
  `run?: AgentRunView` and `thinking?: string`. `isRunning` /
  active-run derivation is driven by the run when present.

### 3. UI — reuse the components

- **`AssistantView`** message list: when a message has `run`, render
  `AgentRunCard` (tool transparency, text-first, collapsible tools, thinking)
  instead of the plain `AssistantBubble`. Plain-text messages (history,
  background, capability-fallback) keep `AssistantBubble`.
- **Status:** render `RunStatusStrip` above the composer while a run streams, and
  swap the composer Send → **Stop** while running (mirroring the Projects chat).
  Remove the redundant run-status label + Stop from the Assistant header (the
  session title/controls stay).
- `AgentRunCard`'s `onOpenArtifact` / `questionState` props are optional; the
  Assistant omits them (questions are out of scope this pass).

## Units and interfaces

| Unit | Responsibility | Interface |
|---|---|---|
| `HermesClient.streamResponses` | Consume `/v1/responses` SSE, yield typed events | `(input) => AsyncIterable<HermesResponseEvent>` |
| `streamSessionTurn` (reworked) | Translate Hermes events → Nexus NDJSON vocabulary | HTTP NDJSON stream (unchanged transport) |
| `agentRunActionsFor` (new, shared) | Map one Nexus event → `AgentRunAction[]` | pure `(event) => AgentRunAction[]` |
| `useAssistantStream` (extended) | Build `AgentRunView` + text/thinking per turn | adds `run`, `thinking` to `AssistantMessage` |
| `AssistantView` (extended) | Render `AgentRunCard` + `RunStatusStrip` + composer Stop | — |

## Error handling

- Stream/transport failure → `{ type: 'error' }` → hook sets `error` and finalizes
  the run as `failed` (existing `RUN_ENDED`/error handling in the reducer).
- Abort → existing reader-cancel + `stopRun`; run finalizes as `cancelled`.
- Capability/endpoint fallback → poll-then-`text_delta` path; message renders as
  plain text (no regression).
- Malformed/unknown SSE events are skipped, not fatal.

## Testing

- **Backend translator** (unit, fake SSE): a Responses stream containing text
  deltas + a `function_call` + its `function_call_output` + `response.completed`
  produces the expected ordered Nexus NDJSON events (`run_start`,
  `tool_execution_start`, `tool_execution_end`, text deltas, `run_end`). Error and
  cancel paths covered. Capability-fallback path still emits the legacy 3 events.
- **`agentRunActionsFor`** (unit): each Nexus event maps to the correct
  `AgentRunAction`(s); `usePiStream`'s existing Projects tests must stay green
  after the refactor (proves behavior preservation).
- **`useAssistantStream`** (component/hook): a structured NDJSON stream yields an
  `AssistantMessage` whose `run` has the expected tools/status and whose `content`
  accumulates the text deltas.
- **`AssistantView`** (component): a message with a `run` renders `AgentRunCard`
  (a tool row is visible); `RunStatusStrip` appears and Send becomes Stop while
  running; a plain message still renders `AssistantBubble`.

## Non-goals (explicit)

- Interactive question blocks (human-in-the-loop) in the Assistant.
- Rich tool history for background/remote handoff runs.
- Rich tool replay for reloaded past sessions (text-only on reload).
- Streaming the vision/image path (stays on `sessionChat`).
- Any change to the Projects chat behavior (the `usePiStream` refactor is
  strictly behavior-preserving).

## Files touched

- `src/backend/hermes/client.ts` — add `streamResponses` + `HermesResponseEvent`
  types; keep existing methods.
- `src/backend/routes/assistant.ts` — rework `streamSessionTurn` into the
  translator; keep background/`sync`/`abort` handlers.
- `src/frontend/src/chat/agent-run-events.ts` — new shared mapping.
- `src/frontend/src/hooks/usePiStream.ts` — refactor to use the shared mapping
  (behavior-preserving).
- `src/frontend/src/hooks/useAssistantStream.ts` — build `run` + `thinking`;
  extend `AssistantMessage`.
- `src/frontend/src/components/AssistantView.tsx` — render `AgentRunCard`,
  `RunStatusStrip`, composer Stop; trim header status.
- Tests alongside each.
