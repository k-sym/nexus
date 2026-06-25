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

  it('keeps a completed latest run expanded so the user can see what they are replying to (issue #108)', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed',
        phase: 'finalizing',
        completedAt: Date.now(),
        tools: [
          { id: '1', name: 'Read', args: {}, status: 'succeeded', queuedAt: 1, completedAt: 2, partialOutput: '' },
        ],
      })}
      content="Here is the answer."
      thinking=""
      detailsExpanded={false}
      isLatest={true}
      onStop={() => {}}
    />);

    // The completed latest run must stay expanded: its content is visible.
    expect(screen.getByText('Here is the answer.')).toBeVisible();
  });

  it('collapses a completed non-latest run (issue #108)', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed',
        phase: 'finalizing',
        completedAt: Date.now(),
        tools: [
          { id: '1', name: 'Read', args: {}, status: 'succeeded', queuedAt: 1, completedAt: 2, partialOutput: '' },
        ],
      })}
      content="Older reply."
      thinking=""
      detailsExpanded={false}
      isLatest={false}
      onStop={() => {}}
    />);

    expect(screen.queryByText('Older reply.')).not.toBeInTheDocument();
  });

  it('places the question card after the assistant prelude text, at the bottom (issue #109)', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed',
        phase: 'finalizing',
        completedAt: Date.now(),
        tools: [
          { id: 'q1', name: 'question', args: {
            questions: [{
              id: 'q',
              header: 'Choose',
              question: 'Which option do you prefer?',
              multiple: false,
              allowOther: false,
              options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
            }],
          }, status: 'running', queuedAt: 1, startedAt: 2, partialOutput: '' },
        ],
      })}
      content="Before I continue, which option do you prefer?"
      thinking=""
      detailsExpanded={false}
      isLatest={true}
      onStop={() => {}}
    />);

    const prelude = screen.getByText('Before I continue, which option do you prefer?');
    const questionPrompt = screen.getByText('Which option do you prefer?');
    expect(prelude).toBeVisible();
    expect(questionPrompt).toBeVisible();
    // The prelude must come before the question card in DOM order.
    expect(prelude.compareDocumentPosition(questionPrompt)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders generated file paths in run content as preview controls', () => {
    const onOpenArtifact = vi.fn();
    const filePath = '/Users/k-sym/Projects/baker-internal/chat-preview-test.md';
    render(<AgentRunCard
      run={run({ status: 'completed', phase: 'finalizing', completedAt: Date.now() })}
      content={`Created it here:\n\n\`${filePath}\``}
      thinking=""
      detailsExpanded
      onStop={() => {}}
      onOpenArtifact={onOpenArtifact}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview chat-preview-test.md' }));
    expect(onOpenArtifact).toHaveBeenCalledWith(filePath);
  });

  it('renders generated bare filenames in run content as preview controls', () => {
    const onOpenArtifact = vi.fn();
    render(<AgentRunCard
      run={run({ status: 'completed', phase: 'finalizing', completedAt: Date.now() })}
      content="Created `test.md` with 10 lines."
      thinking=""
      detailsExpanded
      onStop={() => {}}
      onOpenArtifact={onOpenArtifact}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview test.md' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('test.md');
  });
});
