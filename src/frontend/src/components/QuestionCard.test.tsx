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
  it('walks the stepper and submits exact answers on the last step', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard request={request} onSubmit={onSubmit} />);

    // Step 1 of 2: Scope. Next is disabled until answered; no Submit yet.
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Delivery' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByText('Complete change'));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step 2 of 2: Delivery. Submit replaces Next, disabled until answered.
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Delivery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Now/ }));
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: 'scope', selected: ['full'] },
      { questionId: 'delivery', selected: ['now'] },
    ]);
  });

  it('lets the user step back to a previous question', async () => {
    const user = userEvent.setup();
    render(<QuestionCard request={request} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
    await user.click(screen.getByText('Complete change'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Full/ })).toBeChecked();
  });

  it('uses the shared accent button styling for submitting answers', async () => {
    const user = userEvent.setup();
    render(<QuestionCard request={request} onSubmit={vi.fn()} />);
    await user.click(screen.getByText('Complete change'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Submit answers' })).toHaveClass('accent-button');
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

  it('renders answered results as a compact transcript summary', () => {
    const answeredResult: QuestionToolResult = {
      status: 'answered',
      toolCallId: 'call-1',
      answers: [
        { questionId: 'scope', selected: ['full'] },
        { questionId: 'delivery', selected: [], custom: 'Tomorrow' },
      ],
    };
    render(<QuestionCard request={request} answeredResult={answeredResult} onSubmit={vi.fn()} />);

    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByText('Scope: Full')).toBeInTheDocument();
    expect(screen.getByText('Delivery: Tomorrow')).toBeInTheDocument();
    expect(screen.queryByText('Which scope?')).not.toBeInTheDocument();
    expect(screen.queryByText('How should it ship?')).not.toBeInTheDocument();
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
