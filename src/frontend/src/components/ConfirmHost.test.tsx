import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmHost from './ConfirmHost';
import { confirmDialog } from '../lib/confirm';

/** Trigger a confirm, flushing the resulting state update inside act(). */
function ask(message: string): Promise<boolean> {
  let result!: Promise<boolean>;
  act(() => {
    result = confirmDialog(message);
  });
  return result;
}

describe('confirmDialog + ConfirmHost', () => {
  beforeEach(() => {
    // Keep the trace logs from cluttering test output; they are verified explicitly below.
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('shows the message and resolves true when the user confirms', async () => {
    render(<ConfirmHost />);
    const result = ask('Delete this session? This cannot be undone.');

    expect(await screen.findByText('Delete this session? This cannot be undone.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(await result).toBe(true);
  });

  it('resolves false when the user cancels', async () => {
    render(<ConfirmHost />);
    const result = ask('Archive this session to memory and delete it?');

    await screen.findByText('Archive this session to memory and delete it?');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(await result).toBe(false);
  });

  it('resolves false when dismissed with Escape', async () => {
    render(<ConfirmHost />);
    const result = ask('Delete this memory permanently?');

    await screen.findByText('Delete this memory permanently?');
    await userEvent.keyboard('{Escape}');

    expect(await result).toBe(false);
  });

  it('hides the dialog after a choice is made', async () => {
    render(<ConfirmHost />);
    const result = ask('Delete this project? This cannot be undone.');

    await screen.findByText('Delete this project? This cannot be undone.');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await result;

    await waitFor(() =>
      expect(screen.queryByText('Delete this project? This cannot be undone.')).not.toBeInTheDocument(),
    );
  });

  it('fails safe to false and warns when no ConfirmHost is mounted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await confirmDialog('Delete this session? This cannot be undone.');

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
