# Assistant on the Pi Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and reconstruct the Assistant's transcript through Pi's `SessionManager` (so reopened sessions render as richly as live ones), while Hermes keeps running the agent server-side.

**Architecture:** The Assistant turn driver streams Hermes directly (unchanged live path) but records each turn as **native Pi session entries** (`appendMessage` for user / assistant-with-`toolCall`-blocks / `toolResult`, `appendCustomEntry` for run markers). Reload reconstructs via the existing `flattenEntries`, so historical assistant turns carry a full `run` and render through the shared `AgentRunCard` instead of the plain bubble. No Pi agent loop / provider / local tool execution is involved.

**Tech Stack:** Fastify, better-sqlite3, TypeScript, React 19, `node:test` (backend), Vitest (frontend), Pi SDK `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`.

## Global Constraints

- Documentation/plans live in `project_docs/` (a gitignored Dropbox symlink); never create a root `docs/` tree.
- Do not expose Assistant API keys or bearer tokens in frontend responses.
- Keep the Assistant local-first: if Hermes listing/streaming is unavailable, keep rendering local sessions.
- Hermes stays the agent — never register Hermes as a Pi provider and never invoke Pi's local tool executor.
- Reuse existing code: `HermesClient` (incl. PR #142 listing/adoption), `flattenEntries`, `AGENT_RUN_CUSTOM_TYPE`, `AgentRunCard` / `RunStatusStrip`.

## Reference: confirmed Pi APIs (verbatim)

```ts
// @earendil-works/pi-coding-agent — SessionManager statics + instance
SessionManager.list(cwd: string, sessionDir: string): SessionInfo[]
SessionManager.open(path: string, sessionDir: string, cwd: string): SessionManager
SessionManager.create(cwd: string, sessionDir: string, opts: { id: string }): SessionManager
sm.appendMessage(message: Message | CustomMessage | BashExecutionMessage): string   // returns entryId
sm.appendCustomEntry(customType: string, data?: unknown): string
sm.getEntries(): SessionEntry[]

// @earendil-works/pi-ai — message shapes (required fields shown)
UserMessage       = { role:'user'; content: string | (TextContent|ImageContent)[]; timestamp:number }
AssistantMessage  = { role:'assistant'; content:(TextContent|ThinkingContent|ToolCall)[]; api:string;
                      provider:string; model:string; usage:Usage; stopReason:StopReason; timestamp:number }
ToolResultMessage = { role:'toolResult'; toolCallId:string; toolName:string;
                      content:(TextContent|ImageContent)[]; isError:boolean; timestamp:number; details?:any }
ToolCall          = { type:'toolCall'; id:string; name:string; arguments:Record<string,any> }
TextContent       = { type:'text'; text:string }
ThinkingContent   = { type:'thinking'; thinking:string }
Usage             = { input:0; output:0; cacheRead:0; cacheWrite:0; totalTokens:0;
                      cost:{ input:0; output:0; cacheRead:0; cacheWrite:0; total:0 } }

// @nexus/shared
AGENT_RUN_CUSTOM_TYPE = 'nexus.agent_run'
AgentRunStart = { event:'start'; runId:string; threadId:string; startedAt:string; provider?:string; model?:string }
AgentRunEnd   = { event:'end'; runId:string; threadId:string; assistantEntryId?:string; completedAt:string;
                  status:'completed'|'failed'|'cancelled'|'interrupted'; abortSource?:string; error?:string }

// src/backend/routes/chat.ts
export function flattenEntries(entries: unknown[], repoPath?, options?): unknown[]
// src/backend/pi/runtime.ts
pi.sessionDirFor(cwd: string): string
pi.readMessages(threadId: string, cwd: string): Promise<unknown[]>   // filtered SessionEntry[]
```

`flattenEntries` rebuilds each tool from an assistant `content[].type==='toolCall'` block matched to a `role:'toolResult'` entry by `toolCallId` (result present → status `succeeded`/`failed`; absent → `interrupted`). Run boundary/status comes from the `AGENT_RUN_CUSTOM_TYPE` start/end entries.

---

## Task 1: Assistant Pi-session accessor

Isolates all Pi `SessionManager` interaction behind one testable module keyed by a fixed synthetic cwd. Uses `SessionManager` statics directly (no `AgentSession`, no agent loop), so it is testable with a temp dir and no full runtime.

**Files:**
- Create: `src/backend/pi/assistant-session.ts`
- Test: `src/backend/test/assistant-session.test.ts`

**Interfaces:**
- Produces:
  - `ASSISTANT_CWD: string` — `join(homedir(), '.nexus', 'assistant')`
  - `openAssistantSession(sessionId: string, sessionDir: string, cwd?: string): SessionManager`
  - `appendUserMessage(sm, text: string): string`
  - `appendAssistantMessage(sm, args: { text: string; thinking?: string; toolCalls?: ToolCall[] }): string`
  - `appendToolResult(sm, args: { toolCallId: string; toolName: string; output: string; isError?: boolean }): string`
  - `appendRunStart(sm, event: AgentRunStart): string`
  - `appendRunEnd(sm, event: AgentRunEnd): string`
  - `readAssistantEntries(sessionId: string, sessionDir: string, cwd?: string): unknown[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/test/assistant-session.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openAssistantSession,
  appendUserMessage,
  appendAssistantMessage,
  appendToolResult,
  appendRunStart,
  appendRunEnd,
  readAssistantEntries,
} from '../pi/assistant-session';

test('assistant Pi-session round-trips user/assistant/tool/run entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-assistant-pi-'));
  const cwd = join(dir, 'cwd');
  const sessionDir = join(dir, 'sessions');
  try {
    const sm = openAssistantSession('sess-1', sessionDir, cwd);
    appendRunStart(sm, { event: 'start', runId: 'run-1', threadId: 'sess-1', startedAt: '2026-07-02T10:00:00.000Z' });
    appendUserMessage(sm, 'do the thing');
    const assistantId = appendAssistantMessage(sm, {
      text: 'done',
      toolCalls: [{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: '/x' } }],
    });
    appendToolResult(sm, { toolCallId: 'call-1', toolName: 'read_file', output: 'file body' });
    appendRunEnd(sm, { event: 'end', runId: 'run-1', threadId: 'sess-1', assistantEntryId: assistantId, completedAt: '2026-07-02T10:00:01.000Z', status: 'completed' });

    const entries = readAssistantEntries('sess-1', sessionDir, cwd) as any[];
    const roles = entries.filter((e) => e.type === 'message').map((e) => e.message.role);
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult']);
    const custom = entries.filter((e) => e.type === 'custom' && e.customType === 'nexus.agent_run');
    assert.deepEqual(custom.map((e: any) => e.data.event), ['start', 'end']);
    const assistant = entries.find((e) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.content.find((c: any) => c.type === 'toolCall').id, 'call-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd src/backend && npx tsx --test test/assistant-session.test.ts`
Expected: FAIL — `Cannot find module '../pi/assistant-session'`.

- [ ] **Step 3: Implement the accessor**

```ts
// src/backend/pi/assistant-session.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ToolCall } from '@earendil-works/pi-ai';
import { AGENT_RUN_CUSTOM_TYPE, type AgentRunStart, type AgentRunEnd } from '@nexus/shared';

export const ASSISTANT_CWD = join(homedir(), '.nexus', 'assistant');

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function openAssistantSession(sessionId: string, sessionDir: string, cwd: string = ASSISTANT_CWD): SessionManager {
  const infos = SessionManager.list(cwd, sessionDir);
  const match = infos.find((info: any) => info.id === sessionId);
  return match
    ? SessionManager.open(match.path, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir, { id: sessionId });
}

export function appendUserMessage(sm: SessionManager, text: string): string {
  return sm.appendMessage({ role: 'user', content: text, timestamp: Date.now() } as any);
}

export function appendAssistantMessage(
  sm: SessionManager,
  args: { text: string; thinking?: string; toolCalls?: ToolCall[] },
): string {
  const content: any[] = [];
  if (args.thinking) content.push({ type: 'thinking', thinking: args.thinking });
  if (args.text) content.push({ type: 'text', text: args.text });
  for (const call of args.toolCalls ?? []) content.push(call);
  return sm.appendMessage({
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'hermes',
    model: 'hermes-agent',
    usage: ZERO_USAGE,
    stopReason: (args.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  } as any);
}

export function appendToolResult(
  sm: SessionManager,
  args: { toolCallId: string; toolName: string; output: string; isError?: boolean },
): string {
  return sm.appendMessage({
    role: 'toolResult',
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    content: [{ type: 'text', text: args.output }],
    isError: Boolean(args.isError),
    timestamp: Date.now(),
  } as any);
}

export function appendRunStart(sm: SessionManager, event: AgentRunStart): string {
  return sm.appendCustomEntry(AGENT_RUN_CUSTOM_TYPE, event);
}

export function appendRunEnd(sm: SessionManager, event: AgentRunEnd): string {
  return sm.appendCustomEntry(AGENT_RUN_CUSTOM_TYPE, event);
}

export function readAssistantEntries(sessionId: string, sessionDir: string, cwd: string = ASSISTANT_CWD): unknown[] {
  const infos = SessionManager.list(cwd, sessionDir);
  const match = infos.find((info: any) => info.id === sessionId);
  if (!match) return [];
  const sm = SessionManager.open(match.path, sessionDir, cwd);
  return sm.getEntries().filter((entry: any) =>
    entry.type === 'message' || (entry.type === 'custom' && entry.customType === AGENT_RUN_CUSTOM_TYPE),
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd src/backend && npx tsx --test test/assistant-session.test.ts`
Expected: PASS. If `SessionManager.list` returns a different `info` field than `.id`/`.path`, adjust the `.find`/`open` accordingly (inspect one `info` in the test) — the create/open/list statics are confirmed present in `runtime.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/backend/pi/assistant-session.ts src/backend/test/assistant-session.test.ts
git commit -m "feat(assistant): Pi SessionManager accessor for assistant transcripts"
```

---

## Task 2: Provide the assistant session dir to the routes

Wire a `sessionDir` into the assistant routes so the driver and reload paths can reach Pi's store; keep it injectable for tests.

**Files:**
- Modify: `src/backend/routes/assistant.ts` (options interface + registration closure)
- Modify: wherever `createAssistantRoutes(...)` is registered in server bootstrap (grep: `createAssistantRoutes`)
- Modify: `src/backend/test/routes-assistant.test.ts` (`makeApp` passes a temp `assistantSessionDir`)

**Interfaces:**
- Consumes: `pi.sessionDirFor(ASSISTANT_CWD)` from Task 1 / runtime.
- Produces: `AssistantRoutesOptions.assistantSessionDir?: string`; a closure-level `assistantSessionDir` resolved once.

- [ ] **Step 1: Add the option and resolve it**

In `AssistantRoutesOptions` add `assistantSessionDir?: string;`. Inside `registerAssistantRoutes`, near the top:

```ts
import { ASSISTANT_CWD } from '../pi/assistant-session.js';
// ...
const assistantSessionDir = options.assistantSessionDir
  ?? (fastify.pi ? fastify.pi.sessionDirFor(ASSISTANT_CWD) : join(uploadRoot, 'assistant-sessions'));
```

(The `fastify.pi` fallback keeps prod working; the `uploadRoot` fallback keeps it defined even without pi.)

- [ ] **Step 2: Pass a temp dir from the test harness**

In `routes-assistant.test.ts`, extend `makeApp` to create and pass a session dir:

```ts
function makeApp(options: { config?: ...; fetchImpl?: HermesFetch; activity?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-assistant-test-'));
  const assistantSessionDir = join(dir, 'assistant-sessions');
  // ...
  app.register(createAssistantRoutes(() => options.config ?? { ... }, {
    fetchImpl: options.fetchImpl, uploadRoot: dir, assistantSessionDir,
  }));
  return { app, db, dir, assistantSessionDir, stopActivity };
}
```

- [ ] **Step 3: Pass it in server bootstrap**

At the `createAssistantRoutes(...)` registration site, add `assistantSessionDir: pi.sessionDirFor(ASSISTANT_CWD)` (import `ASSISTANT_CWD`). Confirm `pi` is in scope there (it is where chat routes are registered).

- [ ] **Step 4: Typecheck + existing tests still green**

Run: `npm run --workspace=src/backend typecheck && cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: PASS (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/assistant.ts src/backend/test/routes-assistant.test.ts <bootstrap file>
git commit -m "chore(assistant): thread assistantSessionDir into routes"
```

---

## Task 3: Persist the foreground turn to Pi

Rewrite the persistence side of `streamSessionTurn` (the text/non-vision path) to record the turn as Pi entries. **Leave the live NDJSON translation to the client exactly as-is** — only add persistence.

**Files:**
- Modify: `src/backend/routes/assistant.ts` (`streamSessionTurn`)
- Test: `src/backend/test/routes-assistant.test.ts`

**Interfaces:**
- Consumes: Task 1 accessor helpers; `assistantSessionDir` from Task 2.
- Produces: after a turn, the Pi session for that assistant id contains run-start, user, assistant (+`toolCall`), `toolResult`(s), run-end entries.

- [ ] **Step 1: Write the failing test**

```ts
test('foreground turn persists user/assistant/tool/run entries to the Pi session', async () => {
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
  const { app, db, dir, assistantSessionDir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;
    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'read it' } });

    const { readAssistantEntries } = await import('../pi/assistant-session');
    const entries = readAssistantEntries(sessionId, assistantSessionDir) as any[];
    const roles = entries.filter((e) => e.type === 'message').map((e) => e.message.role);
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult']);
    const assistant = entries.find((e) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), 'Reading. Done.');
    assert.equal(assistant.message.content.find((c: any) => c.type === 'toolCall').id, 'call_1');
    const toolResult = entries.find((e) => e.type === 'message' && e.message.role === 'toolResult') as any;
    assert.equal(toolResult.message.content[0].text, 'hi');
  } finally {
    await cleanup(app, db, dir);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: FAIL — `readAssistantEntries` returns `[]` (turn not persisted to Pi yet).

- [ ] **Step 3: Add persistence inside `streamSessionTurn`**

At the top of the text (non-image) branch, open the session and record run-start + user message. Accumulate tool calls/outputs alongside `accumulated` text/thinking; on completion, write assistant + tool results + run-end. Concretely, add to `streamSessionTurn`:

```ts
import { openAssistantSession, appendUserMessage, appendAssistantMessage, appendToolResult, appendRunStart, appendRunEnd } from '../pi/assistant-session.js';
import type { ToolCall } from '@earendil-works/pi-ai';
// ...
const sm = openAssistantSession(session.id, assistantSessionDir);
appendRunStart(sm, { event: 'start', runId: run.id, threadId: session.id, startedAt: startedAtIso, provider: 'assistant', model: 'hermes-agent' });
appendUserMessage(sm, trimmed);

let thinking = '';
const toolCalls: ToolCall[] = [];
const toolOutputs: Array<{ toolCallId: string; toolName: string; output: string; isError: boolean }> = [];
```

In the streamResponses loop, capture reasoning + tools (the events are already handled for the live stream — add capture):

```ts
else if (ev.kind === 'reasoning_delta') { thinking += ev.delta; write(/* existing thinking_delta */); }
else if (ev.kind === 'function_call') { toolCalls.push({ type: 'toolCall', id: ev.id, name: ev.name, arguments: ev.args }); write(/* existing */); }
else if (ev.kind === 'function_call_output') { toolOutputs.push({ toolCallId: ev.callId, toolName: '', output: ev.output, isError: ev.isError }); write(/* existing */); }
```

After the stream completes (success path, where `appendMessage(db, ...assistant...)` was called before — keep the legacy DB write for now for the lazy-fallback source, OR remove per Task 6), persist to Pi:

```ts
const assistantEntryId = appendAssistantMessage(sm, { text: accumulated, thinking: thinking || undefined, toolCalls });
for (const out of toolOutputs) {
  const name = toolCalls.find((c) => c.id === out.toolCallId)?.name ?? out.toolName;
  appendToolResult(sm, { toolCallId: out.toolCallId, toolName: name, output: out.output, isError: out.isError });
}
appendRunEnd(sm, { event: 'end', runId: run.id, threadId: session.id, assistantEntryId, completedAt: new Date().toISOString(), status: status === 'succeeded' ? 'completed' : (status as any) });
```

On the failure/cancel paths, still call `appendRunEnd` with the terminal status (mirror the existing DB status handling).

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: PASS, including the new test and all prior ones.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/assistant.ts src/backend/test/routes-assistant.test.ts
git commit -m "feat(assistant): persist foreground turns as Pi session entries"
```

---

## Task 4: Reload from Pi with lazy fallback

`GET /api/assistant/sessions/:id` returns messages reconstructed from Pi via `flattenEntries`; if the Pi session has no entries, seed it from the legacy `assistant_session_messages` rows (lazy migration), then reconstruct.

**Files:**
- Modify: `src/backend/routes/assistant.ts` (`GET /api/assistant/sessions/:id`)
- Test: `src/backend/test/routes-assistant.test.ts`

**Interfaces:**
- Consumes: `readAssistantEntries`, `openAssistantSession`, append helpers; `flattenEntries` from `../routes/chat.js`.
- Produces: `session detail` `messages` array is the `flattenEntries` output (rich, with `run`), not raw `assistant_session_messages`.

- [ ] **Step 1: Write the failing test (rich reload + lazy fallback)**

```ts
test('session detail reconstructs a rich transcript from Pi entries', async () => {
  const { app, db, dir, assistantSessionDir } = makeApp({});
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;
    // Seed Pi store directly with a completed tool turn.
    const s = await import('../pi/assistant-session');
    const sm = s.openAssistantSession(sessionId, assistantSessionDir);
    s.appendRunStart(sm, { event: 'start', runId: 'r1', threadId: sessionId, startedAt: '2026-07-02T10:00:00.000Z' });
    s.appendUserMessage(sm, 'hi');
    const aId = s.appendAssistantMessage(sm, { text: 'ok', toolCalls: [{ type: 'toolCall', id: 'c1', name: 'read_file', arguments: {} }] });
    s.appendToolResult(sm, { toolCallId: 'c1', toolName: 'read_file', output: 'body' });
    s.appendRunEnd(sm, { event: 'end', runId: 'r1', threadId: sessionId, assistantEntryId: aId, completedAt: '2026-07-02T10:00:01.000Z', status: 'completed' });

    const res = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const msgs = res.json().messages as any[];
    const assistant = msgs.find((m) => m.role === 'assistant' || m.message?.role === 'assistant');
    assert.ok(assistant, 'assistant message reconstructed');
    assert.ok(JSON.stringify(assistant).includes('read_file'), 'tool activity present on reload');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('session detail lazily seeds Pi store from legacy messages', async () => {
  const { app, db, dir, assistantSessionDir } = makeApp({});
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Old' } });
    const sessionId = created.json().id;
    const now = '2026-07-01T00:00:00.000Z';
    db.prepare(`INSERT INTO assistant_session_messages (id, session_id, remote_message_id, role, content, attachments_json, event_json, created_at) VALUES (?, ?, NULL, ?, ?, '[]', NULL, ?)`)
      .run('m1', sessionId, 'user', 'legacy question', now);
    db.prepare(`INSERT INTO assistant_session_messages (id, session_id, remote_message_id, role, content, attachments_json, event_json, created_at) VALUES (?, ?, NULL, ?, ?, '[]', NULL, ?)`)
      .run('m2', sessionId, 'assistant', 'legacy answer', now);

    const res = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const blob = JSON.stringify(res.json().messages);
    assert.ok(blob.includes('legacy question') && blob.includes('legacy answer'));
    const entries = (await import('../pi/assistant-session')).readAssistantEntries(sessionId, assistantSessionDir) as any[];
    assert.equal(entries.filter((e) => e.type === 'message').length, 2, 'legacy rows seeded into Pi store');
  } finally {
    await cleanup(app, db, dir);
  }
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: FAIL — detail still returns raw `assistant_session_messages`, no `run`/tool reconstruction; Pi store empty in the lazy test.

- [ ] **Step 3: Implement reload + lazy seed**

Add a helper and rewrite the detail route:

```ts
import { flattenEntries } from './chat.js';

function seedPiFromLegacy(db: FastifyInstance['db'], sessionId: string, sessionDir: string): void {
  const legacy = readMessages(db, sessionId); // existing helper
  if (legacy.length === 0) return;
  const sm = openAssistantSession(sessionId, sessionDir);
  for (const m of legacy) {
    if (m.role === 'user') appendUserMessage(sm, m.content);
    else if (m.role === 'assistant') appendAssistantMessage(sm, { text: m.content });
    // system/tool legacy rows (rare) are skipped; they were never richly rendered.
  }
}

function assistantMessages(db: FastifyInstance['db'], sessionId: string, sessionDir: string): unknown[] {
  let entries = readAssistantEntries(sessionId, sessionDir);
  if (entries.length === 0) {
    seedPiFromLegacy(db, sessionId, sessionDir);
    entries = readAssistantEntries(sessionId, sessionDir);
  }
  return flattenEntries(entries, ASSISTANT_CWD, {});
}
```

In `GET /api/assistant/sessions/:id`, replace `messages: readMessages(db, id).map(publicMessage)` with `messages: assistantMessages(db, id, assistantSessionDir)`.

- [ ] **Step 4: Run and confirm pass**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: PASS. (If `flattenEntries` output keys differ from the frontend's expectation, note them for Task 7 — assert here only on presence of the reconstructed assistant + tool.)

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/assistant.ts src/backend/test/routes-assistant.test.ts
git commit -m "feat(assistant): reload transcripts from Pi via flattenEntries with lazy legacy seeding"
```

---

## Task 5: Import (PR #142) writes Pi entries

Point `POST /api/assistant/sessions/import` at the Pi store instead of `assistant_session_messages`; keep idempotency by remote message id.

**Files:**
- Modify: `src/backend/routes/assistant.ts` (`POST /api/assistant/sessions/import`)
- Test: `src/backend/test/routes-assistant.test.ts` (update the existing import test)

**Interfaces:**
- Consumes: Task 1 accessor; existing `hermes.getSession` / `getSessionMessages`.
- Produces: import response `messages` is the reconstructed transcript; re-import does not duplicate.

- [ ] **Step 1: Update the import test to assert Pi persistence + idempotency**

```ts
// In the existing 'Assistant import route adopts a remote Hermes session' test, after asserting 200:
const entries = (await import('../pi/assistant-session')).readAssistantEntries(imported.json().session.id, assistantSessionDir) as any[];
assert.deepEqual(entries.filter((e) => e.type === 'message').map((e: any) => e.message.role), ['user', 'assistant']);
// Re-import is idempotent:
const again = await app.inject({ method: 'POST', url: '/api/assistant/sessions/import', payload: { remoteSessionId: 'remote-api-1' } });
const entries2 = (await import('../pi/assistant-session')).readAssistantEntries(again.json().session.id, assistantSessionDir) as any[];
assert.equal(entries2.filter((e) => e.type === 'message').length, 2, 'no duplicate messages on re-import');
```

(Grab `assistantSessionDir` from `makeApp` in that test.)

- [ ] **Step 2: Run and confirm failure**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: FAIL — import still writes to `assistant_session_messages`; Pi store empty.

- [ ] **Step 3: Rewrite import persistence**

Replace the `assistant_session_messages` INSERT loop in the import route with Pi writes, deduping by remote id via a marker set derived from existing entries:

```ts
const sm = openAssistantSession(session.id, assistantSessionDir);
const existing = readAssistantEntries(session.id, assistantSessionDir) as any[];
const seen = new Set(existing.filter((e) => e.type === 'message').map((e: any) => e.message?.remoteMessageId).filter(Boolean));
for (const message of remoteMessages) {
  const key = message.id ?? `${message.role}:${message.content}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (message.role === 'user') appendUserMessage(sm, message.content);
  else appendAssistantMessage(sm, { text: message.content });
}
```

Return `messages: assistantMessages(db, session.id, assistantSessionDir)` (the helper from Task 4) instead of `readMessages(...).map(publicMessage)`.

> Note: Pi messages have no `remoteMessageId` field, so dedup keys on `id ?? role:content`. Because entries lack that key on read-back, guard re-import by checking message **count/content**: skip if an identical (role, content) pair already exists. Implement `seen` from existing entries' `(role, text)` pairs:
> ```ts
> const seen = new Set(existing.filter((e)=>e.type==='message').map((e:any)=>`${e.message.role}:${extractText(e.message.content)}`));
> // key each remote message as `${role}:${content}` and skip if present
> ```

- [ ] **Step 4: Run and confirm pass**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: PASS, including idempotent re-import.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/assistant.ts src/backend/test/routes-assistant.test.ts
git commit -m "feat(assistant): import adopts remote sessions into the Pi store idempotently"
```

---

## Task 6: Retire legacy message writes on the live path

Stop writing `assistant_session_messages` for new turns (the Pi store is now canonical); keep the table readable for the lazy-fallback seed only.

**Files:**
- Modify: `src/backend/routes/assistant.ts` (`streamSessionTurn` — remove the `appendMessage(db, ...)` calls for user + assistant added content; keep run/session status updates)
- Test: `src/backend/test/routes-assistant.test.ts`

- [ ] **Step 1: Adjust the existing foreground test**

The existing test `'Assistant foreground stream stores user assistant messages and completed run'` asserts rows in `assistant_session_messages`. Change it to assert the Pi entries instead (reuse the Task 3 assertion) and that no new `assistant_session_messages` rows are written:

```ts
const legacyCount = db.prepare('SELECT COUNT(*) c FROM assistant_session_messages WHERE session_id = ?').get(sessionId) as any;
assert.equal(legacyCount.c, 0, 'live turns no longer write legacy messages');
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: FAIL — legacy rows still written.

- [ ] **Step 3: Remove the legacy `appendMessage(db, …)` user/assistant writes**

In `streamSessionTurn`, delete the `appendMessage(db, session.id, 'user', …)` and `appendMessage(db, session.id, 'assistant', accumulated)` calls (the Pi writes from Task 3 replace them). Keep `assistant_sessions` status/`updated_at` updates and run ledger writes.

- [ ] **Step 4: Run and confirm pass**

Run: `cd src/backend && npx tsx --test test/routes-assistant.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/assistant.ts src/backend/test/routes-assistant.test.ts
git commit -m "refactor(assistant): Pi store is canonical; stop writing legacy messages on live turns"
```

---

## Task 7: Frontend — render all assistant messages richly, retire the bubble

Consume the reconstructed (`flattenEntries`) message shape and render every assistant message through `AgentRunCard` + `ChatMessageContent`; drop the plain-text `AssistantBubble` for assistant messages.

**Files:**
- Modify: `src/frontend/src/hooks/useAssistantStream.ts` (map detail `messages` into the `StreamMessage` shape used for rendering)
- Modify: `src/frontend/src/components/AssistantView.tsx` (`SessionRow` untouched; message list + `AssistantBubble`)
- Test: `src/frontend/src/components/AssistantView.test.tsx`

**Interfaces:**
- Consumes: session-detail `messages` now shaped like `usePiStream`'s reconstructed messages (each assistant message carries `run` and content blocks).
- Produces: assistant messages render via `AgentRunCard`; user messages keep the bubble.

- [ ] **Step 1: Write the failing test (reload renders richly, no plain bubble)**

```ts
it('renders a reloaded assistant turn through the shared run card, not a plain bubble', async () => {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/assistant/sessions') {
      return { ok: true, json: async () => ({ sessions: [{ id: 's1', title: 'T', status: 'idle', updated_at: '2026-07-02T10:00:00.000Z' }] }) } as Response;
    }
    if (url === '/api/assistant/sessions/s1') {
      return { ok: true, json: async () => ({
        session: { id: 's1', title: 'T', status: 'idle' },
        messages: [
          { id: 'u1', role: 'user', content: 'hi', created_at: '2026-07-02T10:00:00.000Z' },
          { id: 'a1', role: 'assistant', content: 'read the **file**', created_at: '2026-07-02T10:00:01.000Z',
            run: { runId: 'r1', threadId: 's1', status: 'completed', tools: [{ id: 'c1', name: 'read_file', status: 'succeeded', result: 'body' }] } },
        ],
        latestRun: null,
      }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  });

  render(<AssistantView />);
  // The assistant content renders inside a run card (tool name visible), not a bare bubble.
  expect(await screen.findByText(/read_file/i)).toBeInTheDocument();
});
```

(Match the actual `run`/message shape emitted by `flattenEntries` — capture one real payload from the Task 4 backend test and mirror its keys here.)

- [ ] **Step 2: Run and confirm failure**

Run: `cd src/frontend && npx vitest run src/components/AssistantView.test.tsx`
Expected: FAIL — reloaded assistant message renders as `AssistantBubble` (no `read_file`).

- [ ] **Step 3: Map detail messages + render richly**

In `useAssistantStream.loadSession`, map the reconstructed `messages` into the render shape (attach `run`, `content`, `thinking` the same way `usePiStream` does — reuse its mapping helper; extract it to a shared module if it is currently inline). In `AssistantView`, change the message map so any `message.role !== 'user'` renders through `AgentRunCard` (supplying an `onOpenArtifact` handler), and only user messages use `AssistantBubble`. For user text, render via `ChatMessageContent` too if paths/images matter, else keep as-is.

```tsx
// AssistantView message list
messages.map((message) =>
  message.role !== 'user'
    ? (
      <div key={message.id} className="flex justify-start">
        <AgentRunCard run={message.run ?? null} content={message.content} thinking={message.thinking} detailsExpanded={false} onOpenArtifact={openArtifact} />
      </div>
    )
    : <AssistantBubble key={message.id} message={message} />,
)
```

Add a minimal `openArtifact` handler in `AssistantView` (project-less — a no-op or a best-effort path open; presence of the prop is what enables `ChatMessageContent` markdown/paths):

```tsx
const openArtifact = useCallback((_path: string) => { /* project-less: no preview rail */ }, []);
```

- [ ] **Step 4: Run and confirm pass; then run the full file**

Run: `cd src/frontend && npx vitest run src/components/AssistantView.test.tsx`
Expected: PASS, including prior Assistant tests (remote marker, adopt-on-click, foreground send). Update any prior test that asserted plain-bubble assistant text to expect the run-card rendering.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/hooks/useAssistantStream.ts src/frontend/src/components/AssistantView.tsx src/frontend/src/components/AssistantView.test.tsx
git commit -m "feat(assistant): render assistant turns through the shared run card on live and reload"
```

---

## Task 8: Full verification & cleanup

**Files:** none new — verification + any typecheck fixups.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (shared build + backend + frontend).

- [ ] **Step 2: Backend suite**

Run: `cd src/backend && npm test`
Expected: all pass (was 363 before this work + the new tests).

- [ ] **Step 3: Frontend focused suite**

Run: `cd src/frontend && npx vitest run src/components/AssistantView.test.tsx`
Expected: all pass. (The pre-existing `Sidebar.test.tsx` failure on `main` is unrelated and out of scope.)

- [ ] **Step 4: Manual smoke (if a Hermes endpoint is configured)**

Send a turn in the Assistant, confirm live rendering, reload the session, and confirm the turn still renders richly (no plain-bubble flip) with tool/thinking intact.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A && git commit -m "test(assistant): verification fixups for Pi-pipeline transcripts"
```

---

## Self-Review

- **Spec coverage:** Pi-session accessor (T1), turn persistence (T3), thin index unchanged (no table drop — lazy fallback keeps `assistant_session_messages` readable, T4/T6), reload via `flattenEntries` (T4), lazy fallback (T4), adoption writes Pi entries (T5), frontend convergence + retire bubble (T7), testing (all tasks + T8). Error/abort paths: run-end persists on failure/cancel (T3 Step 3). Vision path: unchanged (still `sessionChat`), not persisted to Pi in this plan — **flagged**: images remain on the legacy path; if rich reload of image turns is wanted, add a follow-up to persist the vision turn via the accessor.
- **Placeholder scan:** none; every code step is concrete. Two adaptation notes (SessionManager `info` field names in T1S4; exact `flattenEntries` output keys in T4S4/T7S1) instruct capturing one real payload rather than guessing — deliberate, not a placeholder.
- **Type consistency:** `ToolCall`/`AssistantMessage`/`ToolResultMessage` shapes match the verbatim reference; accessor function names (`openAssistantSession`, `append*`, `readAssistantEntries`) are used identically across T3–T5; `assistantSessionDir` option name consistent T2–T5.

## Out of scope (per spec)

- Local tool execution / model picker / memory injection (Hermes stays the agent).
- Reusing `ChatPanel` wholesale.
- One-time backfill migration (lazy fallback chosen).
- Persisting the **vision** (image) turn to Pi — noted as a possible follow-up.
