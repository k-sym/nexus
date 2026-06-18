import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ChatPanel from './ChatPanel';

const noop = () => {};

function imageFile(name = 'screen.png', type = 'image/png') {
  return new File(['image-bytes'], name, { type });
}

function documentFile(name = 'notes.pdf', type = 'application/pdf') {
  return new File(['document-bytes'], name, { type });
}

function makeDataTransfer(files: File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types: ['Files'],
  };
}

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

  it('shows compact context usage above the Send button after a turn', async () => {
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
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    event: {
                      type: 'context_usage',
                      usage: { tokens: 182_000, contextWindow: 200_000, percent: 91 },
                    },
                  }) + '\n',
                ),
              );
              controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
              controller.close();
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);

    await userEvent.type(screen.getByTestId('chat-input'), 'check context');
    await userEvent.click(screen.getByTestId('send-button'));

    const composerActions = await screen.findByTestId('composer-actions');
    expect(within(composerActions).getByText('91% (182k/200k)')).toBeInTheDocument();
    expect(screen.queryByText(/Context 91% full/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Consider starting a new session/i)).not.toBeInTheDocument();
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

  it('shows an overlay while dragging images over the chat pane', async () => {
    render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
      />,
    );
    const pane = await screen.findByTestId('chat-drop-target');

    fireEvent.dragEnter(pane, { dataTransfer: makeDataTransfer([imageFile()]) });

    expect(screen.getByText(/Release to attach files/i)).toBeInTheDocument();
  });

  it('drops images into thumbnails above the textarea and sends them', async () => {
    const encoder = new TextEncoder();
    let streamBody: any;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'vision', name: 'Vision', provider: 'openai', input: ['text', 'image'], configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1', last_model_key: 'openai/vision' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        streamBody = JSON.parse(String(init?.body));
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
    const pane = await screen.findByTestId('chat-drop-target');
    fireEvent.drop(pane, { dataTransfer: makeDataTransfer([imageFile('screen.png')]) });

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('chat-input'), 'describe this');
    await userEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => expect(streamBody.images).toHaveLength(1));
    expect(streamBody.images[0].mimeType).toBe('image/png');
  });

  it('clears pending attachments from the composer immediately after sending', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'vision', name: 'Vision', provider: 'openai', input: ['text', 'image'], configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1', last_model_key: 'openai/vision' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        expect(JSON.parse(String(init?.body)).images).toHaveLength(1);
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({ start() {} }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    const pane = await screen.findByTestId('chat-drop-target');
    fireEvent.drop(pane, { dataTransfer: makeDataTransfer([imageFile('screen.png')]) });

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('chat-input'), 'describe this');
    await userEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => expect(screen.queryByTestId('pending-attachment')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('chat-messages')).getByText('describe this')).toBeInTheDocument();
  });

  it('accepts document attachments and sends them without requiring an image-capable model', async () => {
    const encoder = new TextEncoder();
    let streamBody: any;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'text', name: 'Text', provider: 'openai', input: ['text'], configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1', last_model_key: 'openai/text' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        streamBody = JSON.parse(String(init?.body));
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

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    const pane = await screen.findByTestId('chat-drop-target');
    fireEvent.drop(pane, { dataTransfer: makeDataTransfer([documentFile('brief.pdf')]) });

    expect(await screen.findByText('brief.pdf')).toBeInTheDocument();
    expect(screen.getByTestId('send-button')).not.toBeDisabled();
    await userEvent.type(screen.getByTestId('chat-input'), 'summarise this');
    await userEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => expect(streamBody.attachments).toHaveLength(1));
    expect(streamBody.attachments[0]).toMatchObject({ type: 'file', mimeType: 'application/pdf', name: 'brief.pdf' });
    expect(streamBody.images).toBeUndefined();
  });

  it('limits pending image attachments to five', async () => {
    render(
      <ChatPanel
        projectId="p1"
        threadId="t1"
        onBusyConflict={noop}
      />,
    );
    const pane = await screen.findByTestId('chat-drop-target');
    const files = Array.from({ length: 6 }, (_, index) => imageFile(`screen-${index}.png`));

    fireEvent.drop(pane, { dataTransfer: makeDataTransfer(files) });

    expect(await screen.findByText(/Only 5 files can be attached/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('pending-image-thumb')).toHaveLength(5));
  });

  it('disables send when pending images are attached to a text-only model', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'text', name: 'Text', provider: 'openai', input: ['text'], configured: true }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1', last_model_key: 'openai/text' }, messages: [] }) } as Response;
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
    const pane = await screen.findByTestId('chat-drop-target');
    fireEvent.drop(pane, { dataTransfer: makeDataTransfer([imageFile()]) });

    expect(await screen.findByText(/selected model does not support images/i)).toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('renders image attachments on reloaded user messages', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'vision', name: 'Vision', provider: 'openai', input: ['text', 'image'], configured: true }],
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
            thread: { id: 't1', last_model_key: 'openai/vision' },
            messages: [
              {
                id: 'm-user',
                role: 'user',
                content: 'What is in this image?',
                attachments: [{ type: 'image', data: 'abc123', mimeType: 'image/png', name: 'screen.png' }],
                timestamp: 1,
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

    const image = await screen.findByAltText('screen.png');
    expect(image).toHaveAttribute('src', 'data:image/png;base64,abc123');
  });

  it('shows signal-filter savings and reveals raw tool output in details mode', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return {
          ok: true,
          json: async () => ({
            models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }],
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
                id: 'tool-1',
                role: 'toolResult',
                toolName: 'bash',
                content: 'RAW_TOOL_OUTPUT',
                timestamp: 1,
                signal_filter: {
                  input_bytes: 1000,
                  output_bytes: 320,
                  saved_bytes: 680,
                  saved_percent: 68,
                  applied_filters: ['test_output', 'repeated_lines'],
                },
              },
              {
                id: 'tool-2',
                role: 'toolResult',
                toolName: 'read',
                content: 'UNCHANGED_OUTPUT',
                timestamp: 2,
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);

    const indicator = await screen.findByText('Model context: 68% smaller');
    expect(indicator).toHaveAttribute('title', 'Applied filters: test_output, repeated_lines');
    expect(screen.queryByText('RAW_TOOL_OUTPUT')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Model context:.*smaller/)).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(await screen.findByText('RAW_TOOL_OUTPUT')).toBeInTheDocument();
    expect(screen.getByText('UNCHANGED_OUTPUT')).toBeInTheDocument();
  });
});
