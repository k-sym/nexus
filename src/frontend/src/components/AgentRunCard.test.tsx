import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunCard } from './AgentRunCard';
import type { AgentRunView } from '../chat/agent-run-state';

function run(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    status: 'running',
    phase: 'tool_running',
    startedAt: Date.now() - 5_000,
    lastEventAt: Date.now() - 1_000,
    provider: 'openrouter',
    model: 'model-1',
    tools: [{
      id: 'call-1',
      name: 'Bash',
      args: { command: 'npm test' },
      status: 'running',
      queuedAt: Date.now() - 4_000,
      startedAt: Date.now() - 3_000,
      partialOutput: 'running tests',
    }],
    ...overrides,
  };
}

describe('AgentRunCard', () => {
  it('shows running phase, timing, model, and stop control', () => {
    const onStop = vi.fn();
    render(<AgentRunCard run={run()} content="" thinking="" detailsExpanded={false} onStop={onStop} />);

    expect(screen.getByText('Running command')).toBeVisible();
    expect(screen.getByText(/Last activity/)).toBeVisible();
    expect(screen.getByText('openrouter/model-1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Stop current run' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('collapses a completed run to a trustworthy tool summary', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed',
        phase: 'finalizing',
        completedAt: Date.now(),
        tools: [
          { id: '1', name: 'Read', args: {}, status: 'succeeded', queuedAt: 1, completedAt: 2, partialOutput: '' },
          { id: '2', name: 'Bash', args: {}, status: 'failed', queuedAt: 1, completedAt: 2, partialOutput: '', error: 'failed' },
        ],
      })}
      content="Finished"
      thinking=""
      detailsExpanded={false}
      onStop={() => {}}
    />);

    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.getByText('2 tool calls · 1 failed')).toBeVisible();
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
  });

  it('keeps cancelled and interrupted reasons visible', () => {
    const { rerender } = render(<AgentRunCard
      run={run({ status: 'cancelled', abortSource: 'user', phase: 'finalizing', completedAt: Date.now() })}
      content=""
      thinking=""
      detailsExpanded={false}
      onStop={() => {}}
    />);
    expect(screen.getByText('Cancelled by user')).toBeVisible();

    rerender(<AgentRunCard
      run={run({ status: 'interrupted', phase: 'finalizing', completedAt: Date.now(), error: 'Stream disconnected' })}
      content=""
      thinking=""
      detailsExpanded={false}
      onStop={() => {}}
    />);
    expect(screen.getByText('Interrupted')).toBeVisible();
    expect(screen.getByText('Stream disconnected')).toBeVisible();
  });
});
