import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionCard } from './QuestionCard';
import type { QuestionRequest, QuestionToolResult } from '../lib/questions';

const request: QuestionRequest = {
  questions: [
    {
      id: 'scope',
      header: 'Scope',
      question: 'Which scope?',
      options: [
        { value: 'small', label: 'Small', description: 'Minimal change' },
        { value: 'full', label: 'Full', description: 'Complete change' },
      ],
      multiple: false,
      allowOther: false,
    },
    {
      id: 'delivery',
      header: 'Delivery',
      question: 'How should it ship?',
      options: [
        { value: 'now', label: 'Now' },
        { value: 'later', label: 'Later' },
      ],
      multiple: false,
      allowOther: true,
    },
  ],
};

describe('QuestionCard', () => {
  it('submits exact answers only after every question is complete', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard request={request} onSubmit={onSubmit} />);

    expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Delivery' })).toBeInTheDocument();
    expect(screen.getByText('Minimal change')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled();

    await user.click(screen.getByText('Complete change'));
    expect(screen.getByRole('radio', { name: /Full/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Now/ }));
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: 'scope', selected: ['full'] },
      { questionId: 'delivery', selected: ['now'] },
    ]);
  });

  it('supports multiple selections and a custom response', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const multipleRequest: QuestionRequest = {
      questions: [{ ...request.questions[0], multiple: true, allowOther: true }],
    };
    render(<QuestionCard request={multipleRequest} onSubmit={onSubmit} error="Try again" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Try again');
    await user.click(screen.getByRole('checkbox', { name: /Small/ }));
    await user.click(screen.getByRole('checkbox', { name: /Full/ }));
    await user.type(screen.getByRole('textbox', { name: 'Other answer for Scope' }), 'Also docs');
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: 'scope', selected: ['small', 'full'], custom: 'Also docs' },
    ]);
  });

  it('accepts a custom response without a selected option', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard request={{ questions: [request.questions[1]] }} onSubmit={onSubmit} />);

    await user.type(screen.getByRole('textbox', { name: 'Other answer for Delivery' }), 'Tomorrow');
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: 'delivery', selected: [], custom: 'Tomorrow' },
    ]);
  });

  it('renders answered results as read-only chosen labels', () => {
    const answeredResult: QuestionToolResult = {
      status: 'answered',
      toolCallId: 'call-1',
      answers: [
        { questionId: 'scope', selected: ['full'] },
        { questionId: 'delivery', selected: [], custom: 'Tomorrow' },
      ],
    };
    render(<QuestionCard request={request} answeredResult={answeredResult} onSubmit={vi.fn()} />);

    expect(screen.getByText('Full')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('renders interrupted questions as unavailable without controls', () => {
    render(<QuestionCard request={request} unavailable onSubmit={vi.fn()} />);

    expect(screen.getByText('This question is no longer active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
