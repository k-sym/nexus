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
