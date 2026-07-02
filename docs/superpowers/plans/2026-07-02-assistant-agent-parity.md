# Assistant Agent Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Assistant's foreground streamed turns Projects-chat-grade transparency (live tool calls, thinking, consolidated status, collapsible tool detail) by consuming Hermes `/v1/responses` streaming and feeding the existing generic `agentRunReducer` + shared UI components.

**Architecture:** The backend becomes a translation layer — a new `HermesClient.streamResponses()` consumes the `/v1/responses` SSE stream and `streamSessionTurn` emits the *same NDJSON event vocabulary the Projects chat already streams*. The frontend reuses `agentRunReducer` via a shared `agentRunActionsFor` mapping; `useAssistantStream` builds an `AgentRunView` per turn and `AssistantView` renders the shared `AgentRunCard` / `RunStatusStrip`.

**Tech Stack:** Fastify (raw-reply NDJSON streaming), better-sqlite3, TypeScript, Node test runner (backend), React 19 + Vitest + @testing-library/react (frontend).

## Global Constraints

- Backend commands from `src/backend`; frontend commands from `src/frontend`.
- Backend tests: `npm run --workspace=src/backend test -- <file>`. Frontend tests: `npx vitest run <path>` (from `src/frontend`). Typecheck (whole repo): `npm run typecheck` from repo root.
- The NDJSON event vocabulary MUST match the Projects chat stream exactly: run lifecycle uses `{ kind: 'run_start' | 'run_end', run: {...} }`; everything else uses `{ type: '...' }`. Reuse these types verbatim: `run_start` run = `{ runId, threadId, startedAt(ISO), provider?, model? }`; `run_end` run = `{ runId, threadId, completedAt(ISO), status, abortSource?, error? }`.
- Do NOT change the Projects chat's observable behavior. The `usePiStream` refactor (Task 3) is strictly behavior-preserving and guarded by the existing `ChatPanel`/`usePiStream` tests.
- Do NOT change `src/frontend/src/chat/agent-run-state.ts` (the reducer already upserts on `TOOL_STARTED`).
- Streaming endpoint is `/v1/responses` with `stream: true`. If unavailable, fall back to the existing poll-then-text path (no regression).
- Non-goals (do not build): interactive questions in the Assistant, rich history for background/remote or reloaded runs, streaming the vision/image path.
- Leave unrelated pre-existing working-tree changes alone; use scoped `git add`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/backend/hermes/client.ts` (modify) | Add `streamResponses()` + `HermesResponseEvent` types; keep all existing methods. |
| `src/backend/test/hermes-client.test.ts` (modify) | Cover `streamResponses` SSE parsing (text deltas, function_call, function_call_output, completion, error). |
| `src/backend/routes/assistant.ts` (modify) | Rework `streamSessionTurn` into a true-streaming translator (raw reply). Keep vision, background, sync, abort. |
| `src/backend/test/routes-assistant.test.ts` (modify) | Cover the streamed NDJSON event sequence for a tool-using turn + fallback. |
| `src/frontend/src/chat/agent-run-events.ts` (create) | Shared `agentRunActionsFor(event, now): AgentRunAction[]` + `extractStreamText`. |
| `src/frontend/src/chat/agent-run-events.test.ts` (create) | Unit tests for the mapping. |
| `src/frontend/src/hooks/usePiStream.ts` (modify) | Use `agentRunActionsFor` for its RUN_ACTION dispatches (behavior-preserving). |
| `src/frontend/src/hooks/useAssistantStream.ts` (modify) | Build `AgentRunView` + `thinking` per turn; extend `AssistantMessage`. |
| `src/frontend/src/components/AssistantView.tsx` (modify) | Render `AgentRunCard` + `RunStatusStrip` + composer Stop; trim header status. |
| `src/frontend/src/components/AssistantView.test.tsx` (modify) | Cover rich-run rendering, status strip, Stop, plain fallback. |

---

## Task 1: `HermesClient.streamResponses` (consume `/v1/responses` SSE)

**Files:**
- Modify: `src/backend/hermes/client.ts`
- Modify: `src/backend/test/hermes-client.test.ts`

**Interfaces:**
- Produces:
  - `type HermesResponseEvent` (discriminated union below).
  - `HermesClient.streamResponses(input: HermesResponsesInput): AsyncIterable<HermesResponseEvent>`
  - `HermesResponsesInput = { input: string; sessionId?: string; sessionKey?: string; instructions?: string }`

- [ ] **Step 1: Write the failing test**

Add to `src/backend/test/hermes-client.test.ts` (follow the existing `HermesFetch`/`jsonResponse` harness in that file; for SSE build a `Response` from a `ReadableStream` of `data: {...}\n\n` chunks). Add a helper at the top of the test file if one doesn't exist:

```ts
function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
```

Then the test:

```ts
test('streamResponses parses text deltas, function calls, outputs, and completion', async () => {
  let captured: { url: string; body: any } | null = null;
  const fetchImpl: HermesFetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","name":"read_file","arguments":{"path":"/tmp/x"}}}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"call_1","output":"file contents"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  const events = await collect(client.streamResponses({ input: 'hi', sessionId: 's1', sessionKey: 'nexus:assistant:s1' }));

  assert.equal(captured!.url, 'http://127.0.0.1:8642/v1/responses');
  assert.equal(captured!.body.stream, true);
  assert.equal(captured!.body.input, 'hi');
  assert.equal(captured!.body.session_id, 's1');
  assert.deepEqual(events, [
    { kind: 'created', responseId: 'resp_1' },
    { kind: 'text_delta', delta: 'Hel' },
    { kind: 'text_delta', delta: 'lo' },
    { kind: 'function_call', id: 'call_1', name: 'read_file', args: { path: '/tmp/x' } },
    { kind: 'function_call_output', callId: 'call_1', output: 'file contents', isError: false },
    { kind: 'completed', responseId: 'resp_1' },
  ]);
});

test('streamResponses maps a failed response to a failed event', async () => {
  const fetchImpl: HermesFetch = async () => sseResponse([
    'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'k', fetchImpl });
  const events = await collect(client.streamResponses({ input: 'x' }));
  assert.deepEqual(events, [{ kind: 'failed', error: 'boom' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- test/hermes-client.test.ts`
Expected: FAIL (compile error — `streamResponses` does not exist).

- [ ] **Step 3: Implement types + method**

In `src/backend/hermes/client.ts`, add the types near the other interfaces (after `HermesRunStatus`):

```ts
export interface HermesResponsesInput {
  input: string;
  sessionId?: string;
  sessionKey?: string;
  instructions?: string;
}

export type HermesResponseEvent =
  | { kind: 'created'; responseId?: string }
  | { kind: 'text_delta'; delta: string }
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'function_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'function_call_output'; callId: string; output: string; isError: boolean }
  | { kind: 'completed'; responseId?: string }
  | { kind: 'failed'; error: string };
```

Add `streamResponses` to the `HermesClient` interface (after `streamChatCompletions`):

```ts
  streamResponses(input: HermesResponsesInput): AsyncIterable<HermesResponseEvent>;
```

Add the implementation inside the returned object (after `streamChatCompletions`), reusing the SSE line-reading loop pattern already in `streamChatCompletions`:

```ts
    async *streamResponses(input: HermesResponsesInput): AsyncIterable<HermesResponseEvent> {
      const body: Record<string, unknown> = { input: input.input, stream: true };
      if (input.sessionId) body.session_id = input.sessionId;
      if (input.instructions) body.instructions = input.instructions;
      const response = await fetchImpl(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: jsonHeaders(input.sessionKey ? { 'X-Hermes-Session-Key': input.sessionKey } : {}),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Hermes request failed with ${response.status}`);
      }
      if (!response.body) throw new Error('Hermes response did not include a stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const flush = function* (line: string): Generator<HermesResponseEvent> {
        const ev = parseResponsesEvent(line);
        if (ev) yield ev;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) yield* flush(line);
      }
      yield* flush(pending);
    },
```

Add the parser as an exported top-level helper (next to `extractOpenAiDelta`):

```ts
export function parseResponsesEvent(line: string): HermesResponseEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'data: [DONE]') return null;
  const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText) return null;
  let e: any;
  try { e = JSON.parse(jsonText); } catch { return null; }
  switch (e?.type) {
    case 'response.created':
      return { kind: 'created', responseId: e.response?.id };
    case 'response.output_text.delta':
      return typeof e.delta === 'string' ? { kind: 'text_delta', delta: e.delta } : null;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return typeof e.delta === 'string' ? { kind: 'reasoning_delta', delta: e.delta } : null;
    case 'response.output_item.done': {
      const item = e.item ?? {};
      if (item.type === 'function_call') {
        return {
          kind: 'function_call',
          id: String(item.id ?? item.call_id ?? ''),
          name: String(item.name ?? ''),
          args: coerceArgs(item.arguments),
        };
      }
      if (item.type === 'function_call_output') {
        return {
          kind: 'function_call_output',
          callId: String(item.call_id ?? item.id ?? ''),
          output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          isError: Boolean(item.is_error),
        };
      }
      return null;
    }
    case 'response.completed':
      return { kind: 'completed', responseId: e.response?.id };
    case 'response.failed':
    case 'response.incomplete':
      return { kind: 'failed', error: String(e.response?.error?.message ?? e.error?.message ?? 'Assistant run failed.') };
    default:
      return null;
  }
}

function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- test/hermes-client.test.ts`
Expected: PASS (all existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/hermes/client.ts src/backend/test/hermes-client.test.ts
git commit -m "feat(assistant): HermesClient.streamResponses consumes /v1/responses SSE"
```

---

## Task 2: Rework `streamSessionTurn` into a true-streaming translator

**Files:**
- Modify: `src/backend/routes/assistant.ts` (the `streamSessionTurn` function, ~lines 448-555, and its route registrations that call it)
- Modify: `src/backend/test/routes-assistant.test.ts`

**Interfaces:**
- Consumes: `HermesClient.streamResponses` + `HermesResponseEvent` (Task 1).
- Produces: the foreground `/messages/stream` response now streams the Nexus NDJSON vocabulary incrementally: `{kind:'run_start',run}`, `{type:'message_update',assistantMessageEvent:{type:'text_delta'|'thinking_delta',delta}}`, `{type:'tool_execution_start',toolCallId,toolName,args}`, `{type:'tool_execution_end',toolCallId,toolName,result:{content:[{type:'text',text}]},isError}`, `{kind:'run_end',run}`. On error mid-stream: `{type:'error',error}` then `{kind:'run_end',run:{status:'failed'}}`.

- [ ] **Step 1: Write the failing test**

In `src/backend/test/routes-assistant.test.ts` (reuse the file's existing `makeApp({ fetchImpl })` / `cleanup` harness). Add a helper to read an injected NDJSON body into parsed events, and a test that a tool-using turn streams the expected sequence:

```ts
function ndjsonEvents(payload: string): any[] {
  return payload.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('streamSessionTurn streams structured run/tool/text events from /v1/responses', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).endsWith('/v1/responses')) {
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Reading."}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","name":"read_file","arguments":{"path":"/tmp/x"}}}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"call_1","output":"hi"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":" Done."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    // Assistant must be configured for this app (follow the existing configured-app
    // helper in this test file; if tests use a config stub, ensure url+key are set).
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'read the file' },
    });
    assert.equal(res.statusCode, 200);
    const events = ndjsonEvents(res.payload);
    const kinds = events.map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, [
      'run_start', 'message_update', 'tool_execution_start', 'tool_execution_end', 'message_update', 'run_end',
    ]);
    const toolStart = events.find((e) => e.type === 'tool_execution_start');
    assert.equal(toolStart.toolName, 'read_file');
    const toolEnd = events.find((e) => e.type === 'tool_execution_end');
    assert.equal(toolEnd.result.content[0].text, 'hi');
    const runEnd = events.find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'completed');
    // The assistant message is persisted from the accumulated text.
    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const assistantMsg = detail.json().messages.find((m: any) => m.role === 'assistant');
    assert.equal(assistantMsg.content, 'Reading. Done.');
  } finally {
    await cleanup(app, db, dir);
  }
});
```

(Import/define `sseResponse` in this test file too — copy the helper from Task 1's test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- test/routes-assistant.test.ts`
Expected: FAIL (current handler emits `run_start`/`text_delta`/`complete`, not the structured vocabulary; kinds mismatch).

- [ ] **Step 3: Implement the streaming translator**

Rewrite the **text path** of `streamSessionTurn` in `src/backend/routes/assistant.ts` to stream via the raw reply (mirroring `chat.ts`'s hijack pattern). Keep the image/vision path (`hasImageAttachments`) as-is but emit it through the same writer. Replace the body of `streamSessionTurn` (lines 448-555) with:

```ts
    const streamSessionTurn = async (sessionId: string, content: string, attachmentsInput: unknown, reply: any) => {
      const trimmed = content.trim();
      const attachmentsResult = validateAssistantAttachments(attachmentsInput);
      if (!attachmentsResult.ok) { reply.code(400); return { error: attachmentsResult.error }; }
      const savedAttachments = saveAssistantAttachments(attachmentsResult.attachments, uploadRoot);
      const promptContent = promptWithFileReferences(trimmed, savedAttachments);
      if (!trimmed && savedAttachments.length === 0) { reply.code(400); return { error: 'Message content is required.' }; }
      const hermes = client();
      if (!hermes) { reply.code(400); return { error: 'Assistant URL and key must be configured in Settings.' }; }
      const session = getSession(db, sessionId);
      if (!session) { reply.code(404); return { error: 'Assistant session not found' }; }

      appendMessage(db, session.id, 'user', trimmed, savedAttachments);
      const run = createRun(db, session.id, 'chat', promptContent);
      activeRemoteRuns.set(run.id, '');
      fastify.activity?.bus.emit({ type: 'start', operationId: run.id, kind: 'assistant_stream', title: session.title, provider: 'assistant', model: 'hermes-agent' });

      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      const write = (ev: unknown) => { try { reply.raw.write(JSON.stringify(ev) + '\n'); } catch { /* client gone */ } };
      const startedAtIso = new Date().toISOString();
      write({ kind: 'run_start', run: { runId: run.id, threadId: session.id, startedAt: startedAtIso, provider: 'assistant', model: 'hermes-agent' } });

      let accumulated = '';
      let status: string = 'completed';
      let errorMsg: string | undefined;
      try {
        if (hasImageAttachments(savedAttachments)) {
          // Vision path stays non-streaming: one sessionChat call, surfaced as a text delta.
          const remoteSessionId = await ensureRemoteSession(hermes, session);
          const result = await hermes.sessionChat({ sessionId: remoteSessionId, sessionKey: `nexus:assistant:${session.id}`, input: hermesInlineImageInput(promptContent, savedAttachments) });
          accumulated = result.output ?? '';
          if (accumulated) write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: accumulated } });
          completeRun(db, run, { runId: run.id, status: 'completed', sessionId: result.sessionId, output: accumulated, usage: result.usage });
        } else {
          for await (const ev of hermes.streamResponses({ input: promptContent, sessionId: session.remote_session_id ?? session.id, sessionKey: `nexus:assistant:${session.id}` })) {
            if (ev.kind === 'text_delta') { accumulated += ev.delta; write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ev.delta } }); }
            else if (ev.kind === 'reasoning_delta') { write({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ev.delta } }); }
            else if (ev.kind === 'function_call') { write({ type: 'tool_execution_start', toolCallId: ev.id, toolName: ev.name, args: ev.args }); }
            else if (ev.kind === 'function_call_output') { write({ type: 'tool_execution_end', toolCallId: ev.callId, toolName: '', result: { content: [{ type: 'text', text: ev.output }] }, isError: ev.isError }); }
            else if (ev.kind === 'failed') { status = 'failed'; errorMsg = ev.error; }
          }
          completeRun(db, run, { runId: run.id, status: status as any, output: accumulated });
        }
        if (accumulated) appendMessage(db, session.id, 'assistant', accumulated);
      } catch (err: any) {
        status = 'failed';
        errorMsg = err?.message || 'Assistant request failed.';
        const now = new Date().toISOString();
        db.prepare('UPDATE assistant_runs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?').run('failed', errorMsg, now, now, run.id);
        db.prepare('UPDATE assistant_sessions SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, session.id);
        write({ type: 'error', error: errorMsg });
      } finally {
        const completedAtIso = new Date().toISOString();
        write({ kind: 'run_end', run: { runId: run.id, threadId: session.id, completedAt: completedAtIso, status, ...(errorMsg ? { error: errorMsg } : {}) } });
        fastify.activity?.bus.emit({ type: 'stop', operationId: run.id, kind: 'assistant_stream', title: session.title, status: activityStatusForRun(status as any), error: status === 'failed' ? errorMsg : undefined });
        activeRemoteRuns.delete(run.id);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    };
```

Implementation notes for the engineer:
- `streamSessionTurn` now writes to `reply.raw` and returns nothing on the streaming path; the 400/404 early returns still `return { error }` BEFORE `reply.hijack()`. Ensure the route handlers that call `streamSessionTurn` do not also try to serialize a return value after a hijack — if a caller does `return streamSessionTurn(...)`, keep it (the function returns `undefined` after hijack, which Fastify ignores for a hijacked reply). Read the two call sites and confirm.
- `completeRun`'s signature already accepts `{ runId, status, output, ... }` (see the existing vision-path call). Pass the accumulated text as `output`.
- Do NOT change the background `/runs`, `/sync`, or `/abort` handlers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- test/routes-assistant.test.ts`
Expected: PASS. If a pre-existing test asserted the old `run_start`/`text_delta`/`complete` shape for a text turn, update it to the new vocabulary (the streamed `message_update`/`run_end` shape) — that is the intended behavior change.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (repo root) — expected clean.

```bash
git add src/backend/routes/assistant.ts src/backend/test/routes-assistant.test.ts
git commit -m "feat(assistant): stream structured run/tool/text events by consuming /v1/responses"
```

---

## Task 3: Shared `agentRunActionsFor` mapping + refactor `usePiStream`

**Files:**
- Create: `src/frontend/src/chat/agent-run-events.ts`
- Create: `src/frontend/src/chat/agent-run-events.test.ts`
- Modify: `src/frontend/src/hooks/usePiStream.ts`

**Interfaces:**
- Consumes: `AgentRunAction` from `../chat/agent-run-state`.
- Produces: `agentRunActionsFor(ev: StreamEvent, now: number): AgentRunAction[]` and `extractStreamText(content: unknown): string`.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/chat/agent-run-events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { agentRunActionsFor, extractStreamText } from './agent-run-events';

describe('agentRunActionsFor', () => {
  const NOW = 1000;
  it('maps run lifecycle (kind-based)', () => {
    expect(agentRunActionsFor({ kind: 'run_start', run: { runId: 'r', threadId: 't', startedAt: '2026-07-02T00:00:00.000Z' } }, NOW))
      .toEqual([{ type: 'RUN_STARTED', run: { runId: 'r', threadId: 't', startedAt: '2026-07-02T00:00:00.000Z' } }]);
    expect(agentRunActionsFor({ kind: 'run_end', run: { runId: 'r', threadId: 't', completedAt: '2026-07-02T00:00:01.000Z', status: 'completed' } }, NOW))
      .toEqual([{ type: 'RUN_ENDED', run: { runId: 'r', threadId: 't', completedAt: '2026-07-02T00:00:01.000Z', status: 'completed' } }]);
  });
  it('maps text/thinking deltas to MODEL_RESPONDING', () => {
    expect(agentRunActionsFor({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }, NOW)).toEqual([{ type: 'MODEL_RESPONDING', at: NOW }]);
    expect(agentRunActionsFor({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x' } }, NOW)).toEqual([{ type: 'MODEL_RESPONDING', at: NOW }]);
  });
  it('maps tool execution events', () => {
    expect(agentRunActionsFor({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'Bash', args: { command: 'ls' } }, NOW))
      .toEqual([{ type: 'TOOL_STARTED', id: 'c', name: 'Bash', args: { command: 'ls' }, at: NOW }]);
    expect(agentRunActionsFor({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'Bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false }, NOW))
      .toEqual([{ type: 'TOOL_FINISHED', id: 'c', result: 'ok', details: undefined, isError: false, at: NOW }]);
  });
  it('ignores unrelated events', () => {
    expect(agentRunActionsFor({ type: 'context_usage', usage: {} }, NOW)).toEqual([]);
    expect(agentRunActionsFor({ type: 'done' }, NOW)).toEqual([]);
  });
});

describe('extractStreamText', () => {
  it('joins text content blocks', () => {
    expect(extractStreamText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
    expect(extractStreamText('plain')).toBe('plain');
    expect(extractStreamText(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `src/frontend`): `npx vitest run src/chat/agent-run-events.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the shared module**

Create `src/frontend/src/chat/agent-run-events.ts`:

```ts
import type { AgentRunAction } from './agent-run-state';

/** A backend NDJSON stream event (run lifecycle uses `kind`, everything else `type`). */
export type StreamEvent = Record<string, any>;

/** Join tool/message content blocks (or a bare string) into text. */
export function extractStreamText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : '')).join('');
  }
  return '';
}

/**
 * Map one backend stream event to the agent-run reducer action(s) it implies.
 * Shared by the Projects (pi) stream and the Assistant (Hermes) stream so both
 * build an identical AgentRunView. Events that don't affect run state → [].
 */
export function agentRunActionsFor(ev: StreamEvent, now: number): AgentRunAction[] {
  if (ev?.kind === 'run_start') return [{ type: 'RUN_STARTED', run: ev.run }];
  if (ev?.kind === 'run_end') return [{ type: 'RUN_ENDED', run: ev.run }];

  switch (ev?.type) {
    case 'message_update': {
      const ame = ev.assistantMessageEvent;
      if (ame?.type === 'thinking_delta' || ame?.type === 'text_delta') return [{ type: 'MODEL_RESPONDING', at: now }];
      if (ame?.type === 'toolcall_end' && ame.toolCall) {
        return [{ type: 'TOOL_QUEUED', id: ame.toolCall.id, name: ame.toolCall.name, args: ame.toolCall.arguments ?? {}, at: now }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [{ type: 'TOOL_STARTED', id: ev.toolCallId, name: ev.toolName, args: ev.args ?? {}, at: now }];
    case 'tool_execution_update':
      return [{ type: 'TOOL_OUTPUT', id: ev.toolCallId, output: extractStreamText(ev.partialResult?.content), at: now }];
    case 'tool_execution_end':
      return [{ type: 'TOOL_FINISHED', id: ev.toolCallId, result: extractStreamText(ev.result?.content), details: ev.result?.details, isError: !!ev.isError, at: now }];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run the new tests**

Run (from `src/frontend`): `npx vitest run src/chat/agent-run-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `usePiStream` to use the shared mapping (behavior-preserving)**

Read `src/frontend/src/hooks/usePiStream.ts`'s `routeEvent` (~lines 435-532). It currently derives `{ type: 'RUN_ACTION', action: {...} }` dispatches inline for run lifecycle and tool/text events. Replace those inline **RUN_ACTION** derivations with a single call, keeping every non-run dispatch (`TEXT_DELTA`, `THINKING_DELTA`, `TOOL_CALL_START`, `TOOL_CALL_UPDATE`, `MESSAGE_END`, `CONTEXT_USAGE`, `STREAM_ERROR`, `STREAM_COMPLETE`, etc.) exactly as-is:

```ts
import { agentRunActionsFor } from '../chat/agent-run-events';
// ...
// at the top of routeEvent handling for each event `ev`:
for (const action of agentRunActionsFor(ev, Date.now())) {
  dispatch({ type: 'RUN_ACTION', action });
}
```

Then delete the now-redundant inline `dispatch({ type: 'RUN_ACTION', action: {...} })` lines that `agentRunActionsFor` now produces (RUN_STARTED, RUN_ENDED, MODEL_RESPONDING, TOOL_QUEUED, TOOL_STARTED, TOOL_OUTPUT, TOOL_FINISHED). Leave any RUN_ACTION the shared function does NOT cover (e.g. `PREPARING_TOOL`, `RUN_INTERRUPTED`) exactly where they are. If `agentRunActionsFor` and the inline code disagree on any case, treat the **existing usePiStream code as the source of truth** and adjust `agentRunActionsFor` (and its test) to match — behavior preservation wins.

- [ ] **Step 6: Verify Projects chat behavior is unchanged**

Run (from `src/frontend`): `npx vitest run src/hooks/usePiStream.test.ts src/components/ChatPanel.test.tsx src/chat/agent-run-events.test.ts` (include `usePiStream.test.ts` only if it exists; otherwise `ChatPanel.test.tsx` is the guard).
Expected: PASS (no behavior change). Then `npm run typecheck` (root) — clean.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/chat/agent-run-events.ts src/frontend/src/chat/agent-run-events.test.ts src/frontend/src/hooks/usePiStream.ts
git commit -m "refactor(chat): shared agentRunActionsFor mapping used by usePiStream"
```

---

## Task 4: `useAssistantStream` builds an `AgentRunView` + thinking per turn

**Files:**
- Modify: `src/frontend/src/hooks/useAssistantStream.ts`

**Interfaces:**
- Consumes: `agentRunActionsFor` (Task 3), `agentRunReducer` + `AgentRunView` from `../chat/agent-run-state`.
- Produces: `AssistantMessage` gains `run?: AgentRunView` and `thinking?: string`. The streamed assistant draft message carries a live `run`.

- [ ] **Step 1: Write the failing test**

`useAssistantStream` is exercised through `AssistantView` in `AssistantView.test.tsx`. Add a hook-focused assertion there (or a new `useAssistantStream.test.tsx` rendering a tiny probe component). Add this test to `src/frontend/src/components/AssistantView.test.tsx` (reuse its existing `apiFetchMock` harness; the stream endpoint returns an NDJSON `Response` — build one with a `ReadableStream` like the backend tests):

```ts
function ndjsonStreamResponse(events: any[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      c.close();
    },
  });
  return { ok: true, body, json: async () => ({}) } as unknown as Response;
}

it('renders a streamed assistant run with a visible tool call', async () => {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/assistant/sessions') return { ok: true, json: async () => ({ sessions: [{ id: 's1', title: 'S', status: 'idle' }] }) } as Response;
    if (url === '/api/assistant/sessions/s1') return { ok: true, json: async () => ({ session: { id: 's1', title: 'S', status: 'idle' }, messages: [], latestRun: null }) } as Response;
    if (url.endsWith('/messages/stream')) {
      return ndjsonStreamResponse([
        { kind: 'run_start', run: { runId: 'r1', threadId: 's1', startedAt: '2026-07-02T00:00:00.000Z', provider: 'assistant', model: 'hermes-agent' } },
        { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'Bash', args: { command: 'ls' } },
        { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'Bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done.' } },
        { kind: 'run_end', run: { runId: 'r1', threadId: 's1', completedAt: '2026-07-02T00:00:01.000Z', status: 'completed' } },
      ]);
    }
    return { ok: true, json: async () => ({}) } as Response;
  });

  render(<AssistantView />);
  const input = await screen.findByPlaceholderText('Message Assistant...');
  await userEvent.type(input, 'run ls');
  await userEvent.click(screen.getByRole('button', { name: /Send/i }));

  expect(await screen.findByText(/bash.*ls/i)).toBeInTheDocument(); // tool row from AgentRunCard/ToolActivity
  expect(await screen.findByText('Done.')).toBeInTheDocument();      // accumulated text
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `src/frontend`): `npx vitest run src/components/AssistantView.test.tsx`
Expected: FAIL (the hook only handles `run_start`/`text_delta`/`complete`/`error`; no tool row, no `run`).

- [ ] **Step 3: Extend the message type + stream handling**

In `src/frontend/src/hooks/useAssistantStream.ts`:

1. Import the run model at the top:

```ts
import { agentRunReducer, type AgentRunView } from '../chat/agent-run-state';
import { agentRunActionsFor } from '../chat/agent-run-events';
```

2. Extend `AssistantMessage` (lines 54-61):

```ts
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  run?: AgentRunView;
  attachments?: AssistantAttachment[];
  created_at: string;
  isStreaming?: boolean;
}
```

3. In `send()` (the stream loop, ~lines 232-284), replace the four-event `if/else` chain (lines 246-269) with structured handling that also builds the run. Maintain a local `let runView: AgentRunView | null = null;` above the loop, and for each parsed `event`:

```ts
        for (const action of agentRunActionsFor(event, Date.now())) {
          runView = agentRunReducer(runView, action);
        }
        if (event.kind === 'run_start') {
          setMessages((cur) => cur.map((m) => m.id === assistantDraft.id ? { ...m, run: runView ?? undefined } : m));
        } else if (event.type === 'message_update') {
          const ame = event.assistantMessageEvent;
          if (ame?.type === 'text_delta') {
            setMessages((cur) => cur.map((m) => m.id === assistantDraft.id ? { ...m, content: m.content + String(ame.delta ?? ''), run: runView ?? m.run } : m));
          } else if (ame?.type === 'thinking_delta') {
            setMessages((cur) => cur.map((m) => m.id === assistantDraft.id ? { ...m, thinking: (m.thinking ?? '') + String(ame.delta ?? ''), run: runView ?? m.run } : m));
          }
        } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'tool_execution_update') {
          setMessages((cur) => cur.map((m) => m.id === assistantDraft.id ? { ...m, run: runView ?? m.run } : m));
        } else if (event.kind === 'run_end') {
          const status = String(event.run?.status ?? 'completed');
          remoteStillRunning = false;
          setMessages((cur) => cur.map((m) => m.id === assistantDraft.id ? { ...m, run: runView ?? m.run, isStreaming: false } : m));
          setSessions((cur) => cur.map((s) => s.id === selectedSessionId ? { ...s, status: status === 'completed' ? 'idle' : status } : s));
        } else if (event.type === 'error') {
          setError(String(event.error ?? 'Assistant request failed.'));
        }
        // Back-compat: still honor the legacy fallback events if the backend degraded.
        if (event.type === 'text_delta') {
          setMessages((cur) => cur.map((m) => m.id === assistantDraft.id ? { ...m, content: m.content + String(event.delta ?? '') } : m));
        } else if (event.type === 'complete') {
          const status = String(event.status ?? 'succeeded');
          remoteStillRunning = isActiveRunStatus(status);
          setSessions((cur) => cur.map((s) => s.id === selectedSessionId ? { ...s, status: status === 'succeeded' ? 'idle' : status } : s));
        }
```

Notes:
- Keep the surrounding `send()` structure (the `assistantDraft`, `readerRef`, `sendingRef`, `finally` block) intact.
- `isRunning` derivation (line 368) can stay; add `|| !!runView && runView.status === 'running'` is NOT needed because `setIsRunning`/`remoteStillRunning` already track it — verify the existing `isRunning` return still reflects an active streamed run and adjust only if a test shows otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run (from `src/frontend`): `npx vitest run src/components/AssistantView.test.tsx`
Expected: the new test PASSES (tool row + `Done.` visible) once Task 5's rendering is in place. If `AssistantView` does not yet render `AgentRunCard`, this test will still fail on the tool row — that is Task 5. Split expectation: after Task 4, assert the hook attaches a `run` (a lighter assertion), and move the DOM-tool-row assertion to Task 5. Concretely, for Task 4 keep only `expect(await screen.findByText('Done.')).toBeInTheDocument();` and add the tool-row assertion in Task 5.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (root) — clean.

```bash
git add src/frontend/src/hooks/useAssistantStream.ts src/frontend/src/components/AssistantView.test.tsx
git commit -m "feat(assistant): build AgentRunView + thinking from the structured stream"
```

---

## Task 5: `AssistantView` renders `AgentRunCard` + `RunStatusStrip` + composer Stop

**Files:**
- Modify: `src/frontend/src/components/AssistantView.tsx`
- Modify: `src/frontend/src/components/AssistantView.test.tsx`

**Interfaces:**
- Consumes: `AssistantMessage.run` (Task 4); shared `AgentRunCard`, `RunStatusStrip`.

- [ ] **Step 1: Write the failing test**

Add to `AssistantView.test.tsx` (building on Task 4's streamed test), assert the rich rendering + status strip + Stop:

```ts
it('shows the run card tool row, the status strip, and a Stop button while streaming', async () => {
  // Use a stream that stays "open" (do not close the ReadableStream) to keep the run active,
  // OR assert on the completed run's tool row. For the status strip + Stop, drive a run that
  // is still running when asserted. Reuse ndjsonStreamResponse but omit run_end, then assert:
  // (build the mock as in Task 4 but without the final run_end event)
  // ...
  render(<AssistantView />);
  const input = await screen.findByPlaceholderText('Message Assistant...');
  await userEvent.type(input, 'run ls');
  await userEvent.click(screen.getByRole('button', { name: /Send/i }));

  expect(await screen.findByText(/bash.*ls/i)).toBeInTheDocument();        // AgentRunCard/ToolActivity tool row
  expect(await screen.findByTestId('run-status')).toBeInTheDocument();     // RunStatusStrip
  expect(await screen.findByRole('button', { name: 'Stop current run' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `src/frontend`): `npx vitest run src/components/AssistantView.test.tsx`
Expected: FAIL (AssistantBubble renders plain text; no AgentRunCard, no run-status strip, no Stop labelled control).

- [ ] **Step 3: Render the run card + strip + Stop**

In `src/frontend/src/components/AssistantView.tsx`:

1. Imports:

```ts
import { AgentRunCard } from './AgentRunCard';
import { RunStatusStrip } from './RunStatusStrip';
```

2. In the message list (`messages.map((message) => <AssistantBubble .../>)`, ~line 333), render the run card when a run is present:

```tsx
messages.map((message) =>
  message.role !== 'user' && message.run ? (
    <div key={message.id} className="flex justify-start">
      <AgentRunCard run={message.run} content={message.content} thinking={message.thinking} detailsExpanded={false} onStop={() => void abort()} />
    </div>
  ) : (
    <AssistantBubble key={message.id} message={message} />
  ),
)
```

3. Add the status strip above the composer. Find the composer wrapper (`<div className="border-t border-subtle surface-glass p-3">`, ~line 343) and insert immediately before it:

```tsx
{isRunning && (
  <RunStatusStrip
    run={messages.slice().reverse().find((m) => m.run)?.run ?? null}
    fallbackLabel="Working…"
  />
)}
```

4. Swap the Send button for Stop while running. In the composer actions, replace the single Send button (~lines 403-411) with:

```tsx
{isRunning ? (
  <button type="button" onClick={() => void abort()} aria-label="Stop current run" className="h-10 px-4 accent-button rounded-lg transition-colors flex items-center gap-2">
    <Stop size={17} weight="fill" /> Stop
  </button>
) : (
  <button type="button" onClick={() => void handleSend()} disabled={!canSubmit || (isRunning && !isCommand)} className="h-10 px-4 accent-button rounded-lg disabled:opacity-40 transition-colors flex items-center gap-2">
    <PaperPlaneRight size={17} weight="fill" /> Send
  </button>
)}
```

5. Remove the now-duplicated Stop button + run-status label from the header (the header block ~lines 244-297): drop the `<span>{statusLabel(...)}</span>` run-status text and the header Stop button (the one guarded by `isRunning || latestRun?.status === 'running'`). Keep the session title, rename, delete, and sync controls. (`Stop` icon import stays — it is now used by the composer.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `src/frontend`): `npx vitest run src/components/AssistantView.test.tsx`
Expected: PASS (both the Task 4 streamed test and this one). Re-add the tool-row assertion to the Task 4 test now that the card renders.

- [ ] **Step 5: Full frontend suite + typecheck + commit**

Run (from `src/frontend`): `npx vitest run` — expected all green.
Run: `npm run typecheck` (root) — clean.

```bash
git add src/frontend/src/components/AssistantView.tsx src/frontend/src/components/AssistantView.test.tsx
git commit -m "feat(assistant): render AgentRunCard, RunStatusStrip, and composer Stop"
```

---

## Task 6: Full verification & manual preview

**Files:** none (verification only).

- [ ] **Step 1: Whole-repo checks**

Run: `npm run typecheck` (root) — expected clean.
Run (from `src/backend`): `npm run --workspace=src/backend test -- test/hermes-client.test.ts test/routes-assistant.test.ts` — expected green.
Run (from `src/frontend`): `npx vitest run` — expected green.

- [ ] **Step 2: Manual preview checklist**

With a configured Assistant backend (Hermes) and `npm run web` (or `npm run dev`), confirm:
- Sending an Assistant message that triggers a tool shows the tool call live in an `AgentRunCard` (collapsible), with the model's text visible and staying on screen.
- The status strip appears above the composer while streaming; Send becomes Stop; Stop cancels the run.
- The header no longer duplicates run status/Stop.
- A turn with no tools renders as a normal text answer; a reloaded past session still shows final text (no regression); a background handoff run still works with coarse status.

- [ ] **Step 3: Commit any preview fixes**

```bash
git add -A src/frontend src/backend
git commit -m "fix(assistant): preview adjustments for agent parity"
```

---

## Self-Review Notes

- **Spec coverage:** streamResponses (Task 1); backend translation layer + fallback + vision/background preserved (Task 2); shared mapping + generic reducer reuse (Task 3); hook builds AgentRunView + thinking (Task 4); AgentRunCard + RunStatusStrip + composer Stop, header trim (Task 5); verification (Task 6). Non-goals (questions, background/reload rich history, vision streaming) are respected — none add tasks.
- **Behavior preservation:** Task 3 keeps Projects chat green via existing tests; the shared function defers to usePiStream's current behavior on any disagreement.
- **Reducer upsert:** confirmed `TOOL_STARTED` upserts (agent-run-state.ts:132-143), so the Assistant's queued-less tool start works with no reducer change.
- **Ambiguity flagged for implementers:** Task 4/5 split the tool-row DOM assertion (needs Task 5's rendering); Task 2 notes the hijack-return interaction at the call sites to verify.
