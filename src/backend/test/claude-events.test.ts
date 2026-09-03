import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkEventMapper, type MapperSinks } from '../engines/claude/events.js';

function harness() {
  const events: any[] = [];
  const persisted: any[] = [];
  const sessionIds: string[] = [];
  const usage: any[] = [];
  const sinks: MapperSinks = {
    provider: 'claude-code',
    model: 'claude-opus-5',
    contextWindow: 1_000_000,
    emit: (ev) => { events.push(ev); },
    persist: (m) => { persisted.push(m); },
    detailsFor: (id) => (id === 'toolu_q' ? { status: 'answered' } : undefined),
    onSessionId: (id) => { sessionIds.push(id); },
    onContextUsage: (u) => { usage.push(u); },
    now: () => 1_000,
  };
  return { mapper: new SdkEventMapper(sinks), events, persisted, sessionIds, usage };
}

const base = { uuid: 'u', session_id: 'sess-1' };
const stream = (event: any) => ({ type: 'stream_event', event, parent_tool_use_id: null, ...base });
const assistant = (content: any[], stop_reason = 'end_turn', extra: any = {}) => ({
  type: 'assistant', parent_tool_use_id: null, ...base, ...extra,
  message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } },
});

test('init records the session id', () => {
  const h = harness();
  h.mapper.handle({ type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-opus-5', ...base } as any);
  assert.deepEqual(h.sessionIds, ['sess-1']);
});

test('a streamed text turn emits deltas then one message_end and persists the assistant message', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_stop', index: 0 }) as any);
  h.mapper.handle(assistant([{ type: 'text', text: 'Hello' }]) as any);

  const types = h.events.map((e) => e.type === 'message_update' ? `update:${e.assistantMessageEvent.type}` : e.type);
  assert.deepEqual(types, ['message_start', 'update:start', 'update:text_start', 'update:text_delta', 'update:text_delta', 'update:text_end', 'update:done', 'message_end']);
  assert.equal(h.events.at(-1).message.content[0].text, 'Hello');
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].role, 'assistant');
  assert.equal(h.persisted[0].stopReason, 'stop');
  assert.equal(h.persisted[0].provider, 'claude-code');
  assert.deepEqual(h.persisted[0].usage.input, 10);
  assert.deepEqual(h.persisted[0].usage.cacheRead, 3);
});

test('a tool turn emits toolcall events, tool_execution_start/end with display names and side-channel details', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_q', name: 'mcp__nexus__question', input: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"questions":' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[]}' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_stop', index: 0 }) as any);
  h.mapper.handle(assistant([{ type: 'tool_use', id: 'toolu_q', name: 'mcp__nexus__question', input: { questions: [] } }], 'tool_use') as any);
  h.mapper.handle({ type: 'user', parent_tool_use_id: null, ...base, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_q', content: [{ type: 'text', text: 'Scope: Small' }], is_error: false },
  ] } } as any);

  const end = h.events.find((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'toolcall_end');
  assert.deepEqual(end.assistantMessageEvent.toolCall, { type: 'toolCall', id: 'toolu_q', name: 'question', arguments: { questions: [] } });
  const start = h.events.find((e) => e.type === 'tool_execution_start');
  assert.deepEqual(start, { type: 'tool_execution_start', toolCallId: 'toolu_q', toolName: 'question', args: { questions: [] } });
  const done = h.events.find((e) => e.type === 'tool_execution_end');
  assert.equal(done.toolName, 'question');
  assert.equal(done.isError, false);
  assert.deepEqual(done.result.details, { status: 'answered' });
  assert.equal(h.persisted[0].content[0].name, 'question');
  assert.equal(h.persisted[1].role, 'toolResult');
  assert.deepEqual(h.persisted[1].details, { status: 'answered' });
});

test('subagent messages (parent_tool_use_id set) are ignored', () => {
  const h = harness();
  h.mapper.handle({ ...assistant([{ type: 'text', text: 'inner' }]), parent_tool_use_id: 'toolu_task' } as any);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.persisted, []);
});

test('api_retry maps to auto_retry_start and the next output closes it', () => {
  const h = harness();
  h.mapper.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 3, retry_delay_ms: 4000, error_status: 529, error: 'overloaded', ...base } as any);
  h.mapper.handle(assistant([{ type: 'text', text: 'ok' }]) as any);
  assert.deepEqual(h.events[0], { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'overloaded (HTTP 529)' });
  assert.deepEqual(h.events[1], { type: 'auto_retry_end', success: true, attempt: 2 });
});

test('compaction status and boundary map to compaction_start/end exactly once', () => {
  const h = harness();
  h.mapper.handle({ type: 'system', subtype: 'status', status: 'compacting', ...base } as any);
  h.mapper.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 }, ...base } as any);
  h.mapper.handle({ type: 'system', subtype: 'status', status: null, compact_result: 'success', ...base } as any);
  assert.deepEqual(h.events.map((e) => e.type), ['compaction_start', 'compaction_end']);
  assert.equal(h.events[0].reason, 'threshold');
});

test('an assistant error surfaces as an error message end and result does not double-report', () => {
  const h = harness();
  h.mapper.handle(assistant([{ type: 'text', text: 'Invalid API key' }], 'end_turn', { error: 'authentication_failed' }) as any);
  h.mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].message.stopReason, 'error');
  assert.match(ends[0].message.errorMessage, /authentication_failed/);
  assert.deepEqual(h.mapper.finish(), { ok: false, error: 'error_during_execution' });
});

test('a failed result with no prior message synthesises an error message', () => {
  const h = harness();
  h.mapper.handle({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 5, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  assert.equal(h.events.at(-1).type, 'message_end');
  assert.equal(h.persisted[0].stopReason, 'error');
  assert.equal(h.persisted[0].errorMessage, 'error_max_turns');
});

test('abort mid-message persists the partial with stopReason aborted', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }) as any);
  h.mapper.abort();
  const last = h.events.at(-1);
  assert.equal(last.type, 'message_end');
  assert.equal(last.message.stopReason, 'aborted');
  assert.equal(last.message.errorMessage, undefined);
  assert.equal(h.persisted[0].content[0].text, 'partial');
  assert.equal(h.persisted[0].errorMessage, undefined);
  const err = h.events.find((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'error');
  assert.equal(err.assistantMessageEvent.reason, 'aborted');
});

test('fail() with no partial synthesises a single error message and fails finish()', () => {
  const h = harness();
  h.mapper.fail('spawn failed');
  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].message.stopReason, 'error');
  assert.equal(ends[0].message.errorMessage, 'spawn failed');
  assert.deepEqual(h.mapper.finish(), { ok: false, error: 'spawn failed' });
});

test('fail() with a streamed partial closes it as an error, not an abort', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }) as any);
  h.mapper.fail('boom');
  assert.equal(h.persisted[0].content[0].text, 'partial');
  assert.equal(h.persisted[0].stopReason, 'error');
  assert.equal(h.persisted[0].errorMessage, 'boom');
  const err = h.events.find((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'error');
  assert.equal(err.assistantMessageEvent.reason, 'error');
});

test('abort then a failed result does not double-report', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }) as any);
  h.mapper.abort();
  h.mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.equal(h.persisted.length, 1);
});

test('a failed result then fail() does not double-report', () => {
  const h = harness();
  h.mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  h.mapper.fail('x');
  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.equal(h.persisted.length, 1);
  assert.deepEqual(h.mapper.finish(), { ok: false, error: 'x' });
});

test('fail() still closes a live partial after an earlier errored assistant message', () => {
  const h = harness();
  h.mapper.handle(assistant([{ type: 'text', text: 'oops' }], 'end_turn', { error: 'rate_limit' }) as any);
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'again' } }) as any);
  h.mapper.fail('boom');
  const last = h.events.filter((e) => e.type === 'message_end').at(-1);
  assert.equal(last.message.stopReason, 'error');
  assert.equal(last.message.errorMessage, 'boom');
  assert.equal(last.message.content[0].text, 'again');
  assert.equal(h.persisted.length, 2);
});

test('context usage from the assistant message is forwarded in Pi shape', () => {
  const h = harness();
  h.mapper.handle(assistant([{ type: 'text', text: 'x' }], 'end_turn', {
    context_usage: { model: 'claude-opus-5', total_tokens: 12_000, raw_max_tokens: 1_000_000, percentage: 1.2, categories: [], mcp_tools: [] },
  }) as any);
  assert.deepEqual(h.usage, [{ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }]);
});

test('a successful result derives context usage from the last assistant usage and the result modelUsage window', () => {
  const h = harness();
  h.mapper.handle({
    type: 'assistant', parent_tool_use_id: null, ...base,
    message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 150_000, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } },
  } as any);
  h.mapper.handle({
    type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
    usage: {}, modelUsage: { 'claude-opus-5': { contextWindow: 200_000 } }, permission_denials: [], stop_reason: 'end_turn', ...base,
  } as any);
  assert.deepEqual(h.usage.at(-1), { tokens: 150_009, contextWindow: 200_000, percent: 75 });
});

test('a result with no modelUsage and no prior assistant falls back to the result usage and the sink context window', () => {
  const h = harness();
  h.mapper.handle({
    type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0,
    usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], stop_reason: 'end_turn', ...base,
  } as any);
  assert.deepEqual(h.usage.at(-1), { tokens: 50, contextWindow: 1_000_000, percent: 0 });
});

// --- Per-content-block assistant frames -------------------------------------
// While a response streams the CLI emits one `assistant` message per completed
// content block: consecutive frames share `message.id`, each carries just that
// block, `stop_reason` is null and `usage` is not final.

const blockFrame = (content: any[], extra: any = {}) => ({
  type: 'assistant', parent_tool_use_id: null, ...base, ...extra,
  message: {
    id: 'msg-multi', type: 'message', role: 'assistant', model: 'claude-opus-5', content,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 },
  },
});

const toolResultFrame = (toolUseId: string, text: string) => ({
  type: 'user', parent_tool_use_id: null, ...base,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }], is_error: false }] },
});

const resultFrame = { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn', ...base };

test('per-block assistant frames merge into one message, flushed by the tool_result turn', () => {
  const h = harness();
  h.mapper.handle(blockFrame([{ type: 'thinking', thinking: 'weighing it', signature: 'sig' }]) as any);
  h.mapper.handle(blockFrame([{ type: 'text', text: 'Listing the files.' }]) as any);
  h.mapper.handle(blockFrame([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]) as any);
  assert.equal(h.events.filter((e) => e.type === 'message_end').length, 0, 'the turn is still open');

  h.mapper.handle(toolResultFrame('toolu_1', 'a.ts') as any);

  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1, 'exactly one message_end for the whole response');
  assert.deepEqual(ends[0].message.content.map((b: any) => b.type), ['thinking', 'text', 'toolCall']);
  assert.equal(ends[0].message.content[0].thinking, 'weighing it');
  assert.equal(ends[0].message.content[1].text, 'Listing the files.');
  assert.equal(ends[0].message.content[2].id, 'toolu_1');
  assert.equal(h.persisted.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(h.persisted.filter((m) => m.role === 'toolResult').length, 1);

  const starts = h.events.filter((e) => e.type === 'tool_execution_start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].args, { command: 'ls' });
  assert.ok(
    h.events.indexOf(starts[0]) < h.events.findIndex((e) => e.type === 'tool_execution_end'),
    'tool_execution_start precedes tool_execution_end',
  );
});

test('per-block assistant frames closed by the result message flush once', () => {
  const h = harness();
  h.mapper.handle(blockFrame([{ type: 'thinking', thinking: 'ok' }]) as any);
  h.mapper.handle(blockFrame([{ type: 'text', text: 'Done.' }]) as any);
  h.mapper.handle(resultFrame as any);

  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].message.content.map((b: any) => b.type), ['thinking', 'text']);
  assert.equal(ends[0].message.stopReason, 'stop');
  assert.equal(h.persisted.length, 1);
  assert.deepEqual(h.mapper.finish(), { ok: true });
});

test('per-block frames inherit the streamed message_delta stop reason', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listing' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_stop', index: 0 }) as any);
  h.mapper.handle(stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }) as any);
  h.mapper.handle(blockFrame([{ type: 'text', text: 'Listing' }]) as any);
  h.mapper.handle(blockFrame([{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }]) as any);
  h.mapper.handle(toolResultFrame('toolu_2', 'a.ts') as any);

  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].message.stopReason, 'toolUse');
  assert.equal(h.events.filter((e) => e.type === 'message_start').length, 1, 'the streamed start is reused');
  assert.equal(h.persisted.filter((m) => m.role === 'assistant').length, 1);
});

test('markAborting() keeps the SDK\'s terminating error result from becoming an error bubble', () => {
  const h = harness();
  h.mapper.markAborting();
  h.mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.persisted, []);
  assert.deepEqual(h.mapper.finish(), { ok: false, error: 'error_during_execution' });
});

const namedBlockFrame = (id: string, content: any[]) => ({
  type: 'assistant', parent_tool_use_id: null, ...base,
  message: {
    id, type: 'message', role: 'assistant', model: 'claude-opus-5', content,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 },
  },
});

test('a frame that repeats the accumulated content adds nothing twice', () => {
  const h = harness();
  h.mapper.handle(namedBlockFrame('msg-acc', [{ type: 'text', text: 'Hello' }]) as any);
  h.mapper.handle(namedBlockFrame('msg-acc', [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]) as any);
  h.mapper.handle(namedBlockFrame('msg-acc', [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]) as any);
  h.mapper.handle(toolResultFrame('t1', 'a.ts') as any);

  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].message.content.map((b: any) => b.type), ['text', 'toolCall']);
  assert.equal(ends[0].message.content[0].text, 'Hello');
  assert.equal(ends[0].message.content[1].id, 't1');
  assert.equal(h.events.filter((e) => e.type === 'tool_execution_start').length, 1);
});

test('a repeated block that grew replaces the shorter one instead of appending', () => {
  const h = harness();
  h.mapper.handle(namedBlockFrame('msg-grow', [{ type: 'text', text: 'Hel' }]) as any);
  h.mapper.handle(namedBlockFrame('msg-grow', [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]) as any);
  h.mapper.handle(toolResultFrame('t1', 'a.ts') as any);

  const end = h.events.filter((e) => e.type === 'message_end').at(-1);
  assert.deepEqual(end.message.content.map((b: any) => b.type), ['text', 'toolCall']);
  assert.equal(end.message.content[0].text, 'Hello');
  assert.equal(end.message.content[1].id, 't1');
});

test('a buffered response flushed after markAborting() is persisted as aborted', () => {
  const h = harness();
  h.mapper.handle(blockFrame([{ type: 'text', text: 'Half a thought' }]) as any);
  h.mapper.handle(blockFrame([{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'ls' } }]) as any);
  h.mapper.markAborting();
  h.mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);

  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].stopReason, 'aborted');
  assert.equal(h.persisted[0].errorMessage, undefined);
  assert.equal(h.persisted[0].content.length, 2);
  const err = h.events.find((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'error');
  assert.equal(err.assistantMessageEvent.reason, 'aborted');
  // The turn never ran them, so an aborted flush announces no tool executions.
  assert.equal(h.events.filter((e) => e.type === 'tool_execution_start').length, 0);
});
