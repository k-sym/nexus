import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ENGINE_SESSION_CUSTOM_TYPE } from '@nexus/shared';
import { ClaudeEngineSession, preToolUseHook, readStoredSessionId, type QueryFn } from '../engines/claude/session.js';
import { ToolUseCorrelator } from '../engines/claude/tool-use-correlator.js';
import { findClaudeModel } from '../engines/claude/models.js';
import { ApprovalBroker } from '../pi/approvals.js';
import { createToolPolicyResolver } from '../pi/tool-policy.js';
import { NULL_APPROVAL_AUDIT } from '../approvals/audit.js';

const base = { uuid: 'u', session_id: 'sdk-sess-1' };
const init = { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-opus-5', ...base };
const textTurn = (text: string) => [
  init,
  { type: 'assistant', parent_tool_use_id: null, ...base, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn', ...base },
];

/** A fake `query()` that replays fixtures and records the options it was called with. */
function fakeQuery(script: (call: { prompt: unknown; options: any }) => any[] | AsyncIterable<any>) {
  const calls: Array<{ prompt: unknown; options: any }> = [];
  let interrupted = () => {};
  const queryFn = ((params: { prompt: unknown; options?: any }) => {
    const call = { prompt: params.prompt, options: params.options };
    calls.push(call);
    const produced = script(call);
    const iterable = Array.isArray(produced) ? (async function* () { for (const m of produced) yield m; })() : produced;
    return Object.assign(iterable as any, { interrupt: async () => { interrupted(); } });
  }) as unknown as QueryFn;
  return { queryFn, calls, onInterrupt: (fn: () => void) => { interrupted = fn; } };
}

function makeSession(dir: string, queryFn: QueryFn, overrides: Partial<ConstructorParameters<typeof ClaudeEngineSession>[0]> = {}) {
  const cwd = '/repo';
  const sessionManager = SessionManager.create(cwd, join(dir, 'sessions'), { id: 'thread-1' });
  const session = new ClaudeEngineSession({
    threadId: 'thread-1', cwd, sessionManager, model: findClaudeModel('claude-opus-5')!, tools: [],
    systemPromptAppendix: 'Nexus orientation', policy: createToolPolicyResolver(), approvals: new ApprovalBroker(),
    audit: NULL_APPROVAL_AUDIT, env: {}, settingSources: [], skills: 'all', queryFn, ...overrides,
  });
  return { session, sessionManager };
}

test('prompt persists the user turn, streams events, persists the reply and records the SDK session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('Hello'));
    const { session, sessionManager } = makeSession(dir, queryFn);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('hi');

    const entries = sessionManager.getEntries();
    assert.deepEqual(entries.filter((e) => e.type === 'message').map((e: any) => e.message.role), ['user', 'assistant']);
    const record = entries.find((e: any) => e.type === 'custom' && e.customType === ENGINE_SESSION_CUSTOM_TYPE) as any;
    assert.equal(record.data.sessionId, 'sdk-sess-1');
    assert.equal(session.engineSessionId, 'sdk-sess-1');
    assert.ok(events.some((e) => e.type === 'message_end'));
    assert.equal(calls[0].prompt, 'hi');
    assert.equal(calls[0].options.model, 'claude-opus-5');
    assert.equal(calls[0].options.resume, undefined);
    assert.equal(calls[0].options.systemPrompt.append, 'Nexus orientation');
    assert.deepEqual(calls[0].options.disallowedTools, ['AskUserQuestion']);
    assert.ok(calls[0].options.mcpServers.nexus);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getContextUsage() reflects the context window reported in the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn } = fakeQuery(() => [
      init,
      { type: 'assistant', parent_tool_use_id: null, ...base, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 5 } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: { 'claude-opus-5': { contextWindow: 200_000 } }, permission_denials: [], stop_reason: 'end_turn', ...base },
    ]);
    const { session } = makeSession(dir, queryFn);
    await session.prompt('hi');
    assert.deepEqual(session.getContextUsage(), { tokens: 105, contextWindow: 200_000, percent: 0.1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the second turn resumes the recorded SDK session and applies model + thinking changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const { session } = makeSession(dir, queryFn);
    await session.prompt('one');
    await session.setModel(findClaudeModel('claude-sonnet-5')!);
    session.setThinkingLevel('xhigh');
    await session.prompt('two');
    assert.equal(calls[1].options.resume, 'sdk-sess-1');
    assert.equal(calls[1].options.model, 'claude-sonnet-5');
    assert.equal(calls[1].options.effort, 'xhigh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reopened session reads the SDK session id back from the JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn } = fakeQuery(() => textTurn('ok'));
    const { session, sessionManager } = makeSession(dir, queryFn);
    await session.prompt('one');
    const reopened = SessionManager.open(sessionManager.getSessionFile()!, join(dir, 'sessions'), '/repo');
    assert.equal(readStoredSessionId(reopened), 'sdk-sess-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('images are sent as a streaming user message with base64 blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('seen'));
    const { session } = makeSession(dir, queryFn);
    await session.prompt('look', { images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    const messages: any[] = [];
    for await (const m of calls[0].prompt as AsyncIterable<any>) messages.push(m);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canUseTool routes through the tool policy: allow, deny, and confirm via the broker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const approvals = new ApprovalBroker();
    let supervised = false;
    const policy = createToolPolicyResolver({ isSupervised: () => supervised, categoryPolicy: () => ({ services: 'deny' }) });
    const { session } = makeSession(dir, queryFn, { approvals, policy });
    await session.prompt('go');
    const canUseTool = calls[0].options.canUseTool;

    assert.deepEqual(await canUseTool('Read', { file_path: 'a' }, { toolUseID: 't1', signal: new AbortController().signal }), { behavior: 'allow', updatedInput: { file_path: 'a' } });
    const denied = await canUseTool('mcp__nexus__docker_service', { action: 'up' }, { toolUseID: 't2', signal: new AbortController().signal });
    assert.equal(denied.behavior, 'deny');
    assert.match(denied.message, /docker_service/);

    supervised = true;
    const pending = canUseTool('Bash', { command: 'ls' }, { toolUseID: 't3', signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(approvals.pendingCount('thread-1'), 1);
    assert.equal(approvals.listPending()[0].toolName, 'bash');
    approvals.decide('thread-1', 't3', 'allow');
    assert.equal((await pending).behavior, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('abort interrupts the query and persists the partial reply as aborted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { queryFn, onInterrupt } = fakeQuery(() => (async function* () {
      yield init;
      yield { type: 'stream_event', parent_tool_use_id: null, ...base, event: { type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } } };
      yield { type: 'stream_event', parent_tool_use_id: null, ...base, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } };
      await gate;
    })());
    onInterrupt(() => release());
    const { session, sessionManager } = makeSession(dir, queryFn);
    const turn = session.prompt('long');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.abort();
    await turn;
    const assistant = sessionManager.getEntries().find((e: any) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.stopReason, 'aborted');
    assert.equal(assistant.message.content[0].text, 'half');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a query that throws becomes an error reply instead of a rejected prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn } = fakeQuery(() => (async function* () { yield init; throw new Error('spawn failed'); })());
    const { session, sessionManager } = makeSession(dir, queryFn);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('x');
    const assistant = sessionManager.getEntries().find((e: any) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.stopReason, 'error');
    assert.equal(assistant.message.errorMessage, 'spawn failed');
    assert.ok(events.some((e) => e.type === 'message_end'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('abort cancels the turn signal so an in-flight Nexus tool call actually stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { queryFn, onInterrupt, calls } = fakeQuery(() => (async function* () {
      yield init;
      await gate;
    })());
    onInterrupt(() => release());
    const { session } = makeSession(dir, queryFn);
    const turn = session.prompt('long');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.abort();
    await turn;
    assert.equal(calls[0].options.abortController.signal.aborted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synchronously throwing queryFn resolves prompt() with an error reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const queryFn = (() => { throw new Error('bad options'); }) as unknown as QueryFn;
    const { session, sessionManager } = makeSession(dir, queryFn);
    await session.prompt('x');
    const assistant = sessionManager.getEntries().find((e: any) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.stopReason, 'error');
    assert.equal(assistant.message.errorMessage, 'bad options');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop does not surface the SDK terminating error result as an error bubble', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // What the CLI really does after `interrupt()`: it ends the turn with a
    // failed `result` rather than throwing, and that arrives inside the loop.
    const { queryFn, onInterrupt } = fakeQuery(() => (async function* () {
      yield init;
      await gate;
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base };
    })());
    onInterrupt(() => release());
    const { session, sessionManager } = makeSession(dir, queryFn);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    const turn = session.prompt('long');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.abort();
    await turn;

    const assistants = sessionManager.getEntries().filter((e: any) => e.type === 'message' && e.message.role === 'assistant') as any[];
    assert.equal(assistants.some((e) => e.message.stopReason === 'error'), false, 'no error reply persisted for a user-requested stop');
    assert.equal(events.some((e) => e.type === 'message_end' && e.message.errorMessage), false, 'no error bubble emitted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the PreToolUse hook asks Nexus about every tool, including read-only built-ins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const { session } = makeSession(dir, queryFn);
    await session.prompt('go');
    const hook = calls[0].options.hooks.PreToolUse[0].hooks[0];
    const output = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_read', tool_input: { file_path: 'a.ts' } } as any, undefined, {} as any);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'ask', 'read-only built-ins must still reach canUseTool');

    // Same callback, with a correlator the test can read back.
    const correlator = new ToolUseCorrelator();
    const mine = preToolUseHook(correlator);
    const output2 = await mine({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_read2', tool_input: { file_path: 'b.ts' } } as any, undefined, {} as any);
    assert.equal((output2 as any).hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(correlator.claim('Read', { file_path: 'b.ts' }), 'toolu_read2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settingSources and skills from deps flow into the query options', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const { session } = makeSession(dir, queryFn, { settingSources: ['user'], skills: 'all' });
    await session.prompt('go');
    assert.deepEqual(calls[0].options.settingSources, ['user']);
    assert.equal(calls[0].options.skills, 'all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty skills list is passed through as-is and also disables Claude Code\'s bundled skills', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const { session } = makeSession(dir, queryFn, { settingSources: [], skills: [] });
    await session.prompt('go');
    assert.deepEqual(calls[0].options.skills, []);
    assert.equal(calls[0].options.settings?.disableBundledSkills, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skills: all does not disable Claude Code\'s bundled skills', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const { session } = makeSession(dir, queryFn, { settingSources: [], skills: 'all' });
    await session.prompt('go');
    assert.equal(calls[0].options.skills, 'all');
    assert.equal(calls[0].options.settings, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a parked approval is released by the turn hard-abort even when the per-call signal never fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const approvals = new ApprovalBroker();
    const policy = createToolPolicyResolver({ isSupervised: () => true });
    const { session } = makeSession(dir, queryFn, { approvals, policy });
    await session.prompt('go');
    const canUseTool = calls[0].options.canUseTool;

    const neverAborts = new AbortController().signal;
    const pending = canUseTool('Bash', { command: 'ls' }, { toolUseID: 't9', signal: neverAborts });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(approvals.pendingCount('thread-1'), 1);

    calls[0].options.abortController.abort();
    assert.equal((await pending).behavior, 'deny');
    assert.equal(approvals.pendingCount('thread-1'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
