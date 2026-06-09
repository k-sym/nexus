import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChatPanel from './ChatPanel';

const noop = () => {};
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }] }),
  });
});

describe('ChatPanel', () => {
  it('shows the empty state when no thread is selected', () => {
    render(
      <ChatPanel
        projectId="p1"
        threadId={null}
        onBusyConflict={noop}
      />,
    );
    expect(
      screen.getByText(/Select a conversation/i),
    ).toBeInTheDocument();
  });

  it('shows the empty placeholder when a thread is selected but has no messages', async () => {
    render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Send a message to start/i)).toBeInTheDocument());
  });

  it('renders the chat input and the active-model label after models load', async () => {
    render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
      />,
    );
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeInTheDocument();
    // The first button in the panel is the model selector trigger.
    // Clicking it opens the dropdown with the search input.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    await userEvent.click(buttons[0]);
    expect(screen.getByPlaceholderText(/Search models/i)).toBeInTheDocument();
  });
});
