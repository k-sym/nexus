import { render, screen, waitFor, within } from '@testing-library/react';
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
      screen.getByText(/Select a session/i),
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

  it('keeps the just-sent message visible when persisted reload is empty', async () => {
    const encoder = new TextEncoder();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return {
          ok: true,
          json: async () => ({ thread: { id: 't1' }, messages: [] }),
        } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
              controller.close();
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
      />,
    );

    await userEvent.type(screen.getByTestId('chat-input'), 'hello anthropic');
    await userEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(within(screen.getByTestId('chat-messages')).getByText('hello anthropic')).toBeInTheDocument();
    });
  });

  it('auto-submits a task seed exactly once and then reports it consumed', async () => {
    const encoder = new TextEncoder();
    let streamCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        streamCalls += 1;
        // The seeded model must reach the backend as the stream's modelKey.
        expect(JSON.parse(String(init?.body)).modelKey).toBe('anthropic/sonnet-4-5');
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
              controller.close();
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    const onSeedConsumed = vi.fn();
    const seed = { threadId: 't1', prompt: 'Implement the task', modelKey: 'anthropic/sonnet-4-5' };
    const { rerender } = render(
      <ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} seed={seed} onSeedConsumed={onSeedConsumed} />,
    );

    await waitFor(() => {
      expect(within(screen.getByTestId('chat-messages')).getByText('Implement the task')).toBeInTheDocument();
    });
    expect(onSeedConsumed).toHaveBeenCalledTimes(1);
    expect(streamCalls).toBe(1);

    // The seed is cleared by the parent after consumption; a re-render must not re-fire it.
    rerender(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} seed={null} onSeedConsumed={onSeedConsumed} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(streamCalls).toBe(1);
  });

  it('renders user request bubbles with the chat glass treatment instead of the CTA gradient', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return {
          ok: true,
          json: async () => ({
            thread: { id: 't1' },
            messages: [
              {
                id: 'm-user',
                role: 'user',
                content: 'Could you update the deployment YAML?',
                timestamp: 1,
              },
              {
                id: 'm-assistant',
                role: 'assistant',
                content: 'I will check the deployment scripts.',
                timestamp: 2,
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
      />,
    );

    const request = await screen.findByText('Could you update the deployment YAML?');
    const requestBubble = request.closest('[data-chat-role="user"]');

    expect(requestBubble).toHaveClass('chat-request-bubble');
    expect(requestBubble).not.toHaveClass('accent-button');
  });
});
