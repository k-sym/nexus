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

test('context usage from the assistant message is forwarded in Pi shape', () => {
  const h = harness();
  h.mapper.handle(assistant([{ type: 'text', text: 'x' }], 'end_turn', {
    context_usage: { model: 'claude-opus-5', total_tokens: 12_000, raw_max_tokens: 1_000_000, percentage: 1.2, categories: [], mcp_tools: [] },
  }) as any);
  assert.deepEqual(h.usage, [{ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }]);
});
