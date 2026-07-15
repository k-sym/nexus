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
  it('while running shows the active tool and the streaming content, no header', () => {
    render(<AgentRunCard run={run()} content="Partial answer" thinking="" detailsExpanded={false} />);
    expect(screen.getByText('Partial answer')).toBeVisible();
    expect(screen.getByText(/bash.*npm test/i)).toBeVisible();
    // Status/timing/model now live in the composer strip, not the card.
    expect(screen.queryByText('openrouter/model-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop current run' })).not.toBeInTheDocument();
  });

  it('shows finished content text-first with an expandable tool summary', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed', phase: 'finalizing', completedAt: Date.now(),
        tools: [
          { id: '1', name: 'Read', args: {}, status: 'succeeded', queuedAt: 1, completedAt: 2, partialOutput: '' },
          { id: '2', name: 'Bash', args: {}, status: 'failed', queuedAt: 1, completedAt: 2, error: 'failed', partialOutput: '' },
        ],
      })}
      content="Finished" thinking="" detailsExpanded={false}
    />);
    expect(screen.getByText('Finished')).toBeVisible();                 // content shown (text-first)
    const summary = screen.getByRole('button', { name: /2 tool calls/ });
    expect(summary).toHaveTextContent('1 failed');
    expect(summary).toHaveTextContent('Completed');
  });

  it('surfaces an interrupted run error and terminal label', () => {
    render(<AgentRunCard
      run={run({ status: 'interrupted', phase: 'finalizing', completedAt: Date.now(), error: 'Stream disconnected' })}
      content="" thinking="" detailsExpanded={false}
    />);
    expect(screen.getByText('Stream disconnected')).toBeVisible();
    expect(screen.getByRole('button', { name: /tool call/ })).toHaveTextContent('Interrupted');
  });

  it('keeps a still-pending question after the assistant prelude text, at the bottom (issue #109)', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed', phase: 'finalizing', completedAt: Date.now(),
        tools: [
          { id: 'q1', name: 'question', args: {
            questions: [{ id: 'q', header: 'Choose', question: 'Which option do you prefer?',
              multiple: false, allowOther: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
          }, status: 'running', queuedAt: 1, startedAt: 2, partialOutput: '' },
        ],
      })}
      content="Before I continue, which option do you prefer?"
      thinking="" detailsExpanded={false}
    />);
    const prelude = screen.getByText('Before I continue, which option do you prefer?');
    const questionPrompt = screen.getByText('Which option do you prefer?');
    expect(prelude.compareDocumentPosition(questionPrompt)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('moves an answered question inline above the work that followed it (issue #109 follow-up)', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed', phase: 'finalizing', completedAt: Date.now(),
        tools: [
          { id: 'q1', name: 'question', args: {
            questions: [{ id: 'q', header: 'Choose', question: 'Which option do you prefer?',
              multiple: false, allowOther: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
          }, status: 'succeeded', queuedAt: 1, completedAt: 2, partialOutput: '' },
        ],
      })}
      content="Here is what I did after you answered."
      thinking="" detailsExpanded={false}
      questionState={{ q1: { result: { status: 'answered', toolCallId: 'q1', answers: [{ questionId: 'q', selected: ['a'] }] } } }}
    />);
    const answered = screen.getByText('Answered');
    const content = screen.getByText('Here is what I did after you answered.');
    // Answered card sits BEFORE the content the model produced afterward.
    expect(answered.compareDocumentPosition(content)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders generated file paths in run content as preview controls', () => {
    const onOpenArtifact = vi.fn();
    const filePath = '/Users/k-sym/Projects/baker-internal/chat-preview-test.md';
    render(<AgentRunCard
      run={run({ status: 'completed', phase: 'finalizing', completedAt: Date.now(), tools: [] })}
      content={`Created it here:\n\n\`${filePath}\``}
      thinking="" detailsExpanded onOpenArtifact={onOpenArtifact}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview chat-preview-test.md' }));
    expect(onOpenArtifact).toHaveBeenCalledWith(filePath);
  });
});
