import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallTimeline, QuestionCards, ToolActivity } from './ToolCallTimeline';

describe('ToolCallTimeline', () => {
  it('communicates interrupted status with text and supports local expansion', () => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'call-1',
        name: 'Bash',
        args: { command: 'npm test' },
        status: 'interrupted',
        result: 'last output',
      }]}
      detailsExpanded={false}
    />);

    expect(screen.getByText('Interrupted')).toBeVisible();
    const row = screen.getByRole('button', { name: /bash.*npm test/i });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('last output')).toBeVisible();
  });

  it('does not render question tool calls (those are rendered by QuestionCards)', () => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'q1',
        name: 'question',
        args: { questions: [{
          id: 'q', header: 'Choose', question: 'Pick one?',
          multiple: false, allowOther: false,
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        }] },
        status: 'running',
      }]}
      detailsExpanded={false}
    />);

    // The timeline skips question tools, so nothing renders.
    expect(screen.queryByText('Pick one?')).not.toBeInTheDocument();
    expect(screen.queryByText('Choose')).not.toBeInTheDocument();
  });

  // Providers disagree on tool-name casing: pi emits 'Read', others 'read'.
  // Matching on the raw name lost the header formatting AND — worse — sent a
  // failed read down the "reads render nothing" path, hiding the error.
  it('formats lower-case tool names the same as capitalised ones', () => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'read-1',
        name: 'read',
        args: { path: '/Users/k-sym/Projects/nexus/src/shared' },
        status: 'succeeded',
        result: 'file contents',
      }]}
      detailsExpanded
    />);

    expect(screen.getByText('read ~/Projects/nexus/src/shared')).toBeVisible();
  });

  it.each(['Read', 'read'])('shows the output of a failed %s instead of swallowing it', (name) => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'read-1',
        name,
        args: { path: '/Users/k-sym/Projects/nexus/src/shared' },
        status: 'error',
        result: 'EISDIR: illegal operation on a directory, read',
      }]}
      detailsExpanded
    />);

    expect(screen.getByText('EISDIR: illegal operation on a directory, read')).toBeVisible();
  });

  it('still hides the body of a successful read', () => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'read-1',
        name: 'Read',
        args: { path: '/a/b.ts' },
        status: 'succeeded',
        result: 'the whole file',
      }]}
      detailsExpanded
    />);

    expect(screen.queryByText('the whole file')).not.toBeInTheDocument();
  });
});

describe('QuestionCards', () => {
  it('renders question tool calls as QuestionCards', () => {
    render(<QuestionCards
      toolCalls={[{
        id: 'q1',
        name: 'question',
        args: { questions: [{
          id: 'q', header: 'Choose', question: 'Pick one?',
          multiple: false, allowOther: false,
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        }] },
        status: 'running',
      }]}
    />);

    expect(screen.getByText('Choose')).toBeVisible();
    expect(screen.getByText('Pick one?')).toBeVisible();
  });
});

describe('ToolActivity', () => {
  const finishedTools = [
    { id: '1', name: 'Read', args: { path: '/a' }, status: 'succeeded' as const },
    { id: '2', name: 'Bash', args: { command: 'npm test' }, status: 'failed' as const, result: 'boom' },
  ];

  it('while running shows the active tool and folds the rest into a count', () => {
    render(<ToolActivity
      running
      toolCalls={[
        { id: '1', name: 'Read', args: { path: '/a' }, status: 'succeeded' },
        { id: '2', name: 'Bash', args: { command: 'npm test' }, status: 'running' },
      ]}
    />);
    expect(screen.getByText(/bash.*npm test/i)).toBeVisible();      // active tool shown
    expect(screen.getByText(/2 tool calls/)).toBeVisible();          // summary count
    expect(screen.queryByText(/read/i)).not.toBeInTheDocument();     // completed folded away
  });

  it('when finished shows a collapsed summary with the terminal label and expands on click', () => {
    render(<ToolActivity running={false} toolCalls={finishedTools} terminalLabel="Completed" />);
    const summary = screen.getByRole('button', { name: /2 tool calls/ });
    expect(summary).toHaveTextContent('1 failed');
    expect(summary).toHaveTextContent('Completed');
    expect(screen.queryByText(/npm test/)).not.toBeInTheDocument();  // list hidden by default
    fireEvent.click(summary);
    expect(screen.getByText(/bash.*npm test/i)).toBeVisible();       // full list revealed
  });

  it('renders nothing when there are no non-question tools', () => {
    const { container } = render(<ToolActivity running={false} toolCalls={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('approval stamps (#374)', () => {
  it('shows who approved a gated call, distinct from a partner decision', () => {
    render(<ToolCallTimeline
      toolCalls={[
        {
          id: 'gated-1', name: 'Bash', args: { command: 'npm --version' },
          status: 'succeeded', result: '11.6.2',
          approval: { outcome: 'allowed', answeredBy: 'human' },
        },
        {
          id: 'gated-2', name: 'Bash', args: { command: 'ls' },
          status: 'succeeded', result: '',
          approval: { outcome: 'allowed', answeredBy: 'partner' },
        },
      ]}
      detailsExpanded={false}
    />);

    expect(screen.getByText('approved — you')).toBeVisible();
    expect(screen.getByText('approved — partner')).toBeVisible();
  });

  it('renders a denial with its decider and keeps ungated calls unstamped', () => {
    render(<ToolCallTimeline
      toolCalls={[
        {
          id: 'gated-3', name: 'Bash', args: { command: 'rm -rf /' },
          status: 'failed', result: 'Denied',
          approval: { outcome: 'denied', answeredBy: 'human', reason: 'no thanks' },
        },
        { id: 'plain-1', name: 'read', args: { path: '/x' }, status: 'succeeded', result: 'ok' },
      ]}
      detailsExpanded={false}
    />);

    expect(screen.getByText('denied — you')).toBeVisible();
    expect(screen.queryByText(/approved —/)).not.toBeInTheDocument();
  });

  it('labels a timeout as auto-denied', () => {
    render(<ToolCallTimeline
      toolCalls={[{
        id: 'gated-4', name: 'Bash', args: { command: 'true' },
        status: 'failed', result: '',
        approval: { outcome: 'denied', answeredBy: 'timeout' },
      }]}
      detailsExpanded={false}
    />);

    expect(screen.getByText('auto-denied — timed out')).toBeVisible();
  });
});
