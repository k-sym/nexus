import { describe, expect, it } from 'vitest';
import { agentRunReducer, type AgentRunView } from './agent-run-state';

function startRun(): AgentRunView {
  return agentRunReducer(null, {
    type: 'RUN_STARTED',
    run: {
      runId: 'run-1',
      threadId: 'thread-1',
      startedAt: '2026-06-22T10:00:00.000Z',
      provider: 'openrouter',
      model: 'model-1',
    },
  })!;
}

describe('agentRunReducer', () => {
  it('starts in a waiting-for-provider phase with stable metadata', () => {
    const run = startRun();
    expect(run).toMatchObject({
      runId: 'run-1',
      status: 'running',
      phase: 'waiting_for_provider',
      provider: 'openrouter',
      model: 'model-1',
      startedAt: Date.parse('2026-06-22T10:00:00.000Z'),
      lastEventAt: Date.parse('2026-06-22T10:00:00.000Z'),
      tools: [],
    });
  });

  it('keeps ordered tools and separates queued, running, and completed states', () => {
    let run = startRun();
    run = agentRunReducer(run, { type: 'TOOL_QUEUED', id: 'call-1', name: 'Read', args: { path: '/a' }, at: 10 })!;
    run = agentRunReducer(run, { type: 'TOOL_STARTED', id: 'call-1', name: 'Read', args: { path: '/a' }, at: 20 })!;
    run = agentRunReducer(run, { type: 'TOOL_FINISHED', id: 'call-1', at: 30, result: 'ok', isError: false })!;
    run = agentRunReducer(run, { type: 'TOOL_QUEUED', id: 'call-2', name: 'Bash', args: { command: 'npm test' }, at: 40 })!;
    run = agentRunReducer(run, { type: 'TOOL_STARTED', id: 'call-2', name: 'Bash', args: { command: 'npm test' }, at: 50 })!;

    expect(run.tools.map((tool) => tool.id)).toEqual(['call-1', 'call-2']);
    expect(run.tools[0]).toMatchObject({ status: 'succeeded', completedAt: 30, result: 'ok' });
    expect(run.tools[1]).toMatchObject({ status: 'running', startedAt: 50 });
    expect(run.phase).toBe('tool_running');
  });

  it('records first output and appends partial output', () => {
    let run = startRun();
    run = agentRunReducer(run, { type: 'TOOL_STARTED', id: 'call-1', name: 'Bash', args: {}, at: 10 })!;
    run = agentRunReducer(run, { type: 'TOOL_OUTPUT', id: 'call-1', output: 'tests 20/40', at: 20 })!;
    run = agentRunReducer(run, { type: 'TOOL_OUTPUT', id: 'call-1', output: '\npassed', at: 30 })!;

    expect(run.tools[0]).toMatchObject({
      firstOutputAt: 20,
      partialOutput: 'tests 20/40\npassed',
    });
  });

  it('marks unfinished tools cancelled for a user cancellation', () => {
    let run = startRun();
    run = agentRunReducer(run, { type: 'TOOL_STARTED', id: 'call-1', name: 'Write', args: {}, at: 10 })!;
    run = agentRunReducer(run, {
      type: 'RUN_ENDED',
      run: {
        runId: 'run-1',
        threadId: 'thread-1',
        completedAt: '2026-06-22T10:00:10.000Z',
        status: 'cancelled',
        abortSource: 'user',
      },
    })!;

    expect(run.status).toBe('cancelled');
    expect(run.abortSource).toBe('user');
    expect(run.tools[0].status).toBe('cancelled');
  });

  it('marks unfinished tools interrupted when the stream ends without a terminal event', () => {
    let run = startRun();
    run = agentRunReducer(run, { type: 'TOOL_STARTED', id: 'call-1', name: 'Edit', args: {}, at: 10 })!;
    run = agentRunReducer(run, { type: 'RUN_INTERRUPTED', at: 20, error: 'Stream disconnected' })!;

    expect(run.status).toBe('interrupted');
    expect(run.tools[0].status).toBe('interrupted');
  });

  it('does not let assistant prose mark an unfinished tool successful', () => {
    let run = startRun();
    run = agentRunReducer(run, { type: 'TOOL_STARTED', id: 'call-1', name: 'Write', args: {}, at: 10 })!;
    run = agentRunReducer(run, { type: 'MODEL_RESPONDING', at: 20 })!;

    expect(run.tools[0].status).toBe('running');
  });
});
