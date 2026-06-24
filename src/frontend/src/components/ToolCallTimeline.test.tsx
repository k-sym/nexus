import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallTimeline, QuestionCards } from './ToolCallTimeline';

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
