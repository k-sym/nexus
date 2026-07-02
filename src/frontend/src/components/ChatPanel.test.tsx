import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('disables the composer and ignores Enter while a turn is running', async () => {
    let streamCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        streamCalls += 1;
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({ start() {} }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    const input = screen.getByTestId('chat-input');
    await userEvent.type(input, 'first prompt');
    await userEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'second prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(streamCalls).toBe(1);
  });

  it('shows a persistent run-status strip while a turn is running', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        return { ok: true, status: 200, body: new ReadableStream({ start() {} }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    // No strip before a run starts.
    expect(screen.queryByTestId('run-status')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('chat-input'), 'hello');
    await userEvent.click(screen.getByTestId('send-button'));

    const strip = await screen.findByTestId('run-status');
    expect(strip).toHaveTextContent(/Thinking|Model responding|Working/);
  });

  it('submits a native question answer without starting a continuation turn', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return {
          ok: true,
          json: async () => ({
            thread: { id: 't1' },
            messages: [{
              id: 'assistant-1', role: 'assistant', content: '', timestamp: 1,
              tool_calls: [{
                id: 'call-1', name: 'question', status: 'running',
                args: { questions: [{
                  id: 'scope', header: 'Scope', question: 'Which scope?', allowOther: false,
                  options: [{ value: 'small', label: 'Small' }, { value: 'full', label: 'Full' }],
                }] },
              }],
            }],
          }),
        } as Response;
      }
      if (url === '/api/threads/t1/questions/call-1/answer') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock;

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Full' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/threads/t1/questions/call-1/answer',
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument());
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByText('Scope: Full')).toBeInTheDocument();
    expect(screen.queryByText('Which scope?')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/messages/stream'))).toHaveLength(0);
  });

  it('renders an incomplete persisted native question as unavailable', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [] }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [{
          id: 'assistant-1', role: 'assistant', content: '', timestamp: 1,
          tool_calls: [{
            id: 'call-1', name: 'question', status: 'completed',
            args: { questions: [{
              id: 'scope', header: 'Scope', question: 'Which scope?', allowOther: false,
              options: [{ value: 'small', label: 'Small' }, { value: 'full', label: 'Full' }],
            }] },
          }],
        }] }) } as Response;
      }
      return { ok: true, json: async () => ({ busy: false }) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    expect(await screen.findByText('This question is no longer active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument();
  });

  it('re-attaches to a still-running backend run: gates the composer, polls for progress, and cancels via /abort', async () => {
    const runningMessages = {
      thread: { id: 't1' },
      messages: [{
        id: 'assistant-1', role: 'assistant', content: '', timestamp: 1,
        run: {
          runId: 'run-1', threadId: 't1', status: 'running', phase: 'tool_running',
          startedAt: 1, lastEventAt: 1, provider: 'anthropic', model: 'sonnet',
          tools: [{ id: 'call-1', name: 'Bash', args: { command: 'npm test' }, status: 'running' }],
        },
      }],
    };
    const completedMessages = {
      thread: { id: 't1' },
      messages: [{
        id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 1,
        run: { runId: 'run-1', threadId: 't1', status: 'completed', phase: 'finalizing', startedAt: 1, lastEventAt: 2, completedAt: 2, tools: [{ id: 'call-1', name: 'Bash', args: { command: 'npm test' }, status: 'succeeded', result: 'ok' }] },
      }],
    };
    let aborted = false;
    const abortCalls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => (aborted ? completedMessages : runningMessages) } as Response;
      }
      if (url === '/api/threads/t1/abort') {
        abortCalls.push(init?.body ? JSON.parse(String(init.body)).source : 'unknown');
        aborted = true;
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    const input = screen.getByTestId('chat-input');

    // The running run re-attaches: its Stop control renders, and the composer is gated
    // even though this instance isn't streaming the run itself.
    await screen.findByRole('button', { name: 'Stop current run' });
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument();

    // Stop cancels the backend run via the explicit /abort endpoint.
    screen.getByRole('button', { name: 'Stop current run' }).click();
    await waitFor(() => expect(abortCalls).toEqual(['user']));

    // Polling reconciles progress: once the run is no longer running, the composer re-enables.
    await waitFor(() => expect(input).not.toBeDisabled(), { timeout: 4000 });
  }, 15000);

  it('does not duplicate the user prompt when a dropped stream is reconciled by the re-attach poller', async () => {
    const encoder = new TextEncoder();
    let persisted = false;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const persistedMessages = {
      thread: { id: 't1' },
      messages: [
        { id: 'user-1', role: 'user', content: 'hi there', timestamp: 1 },
        {
          id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 2,
          run: { runId: 'run-1', threadId: 't1', status: 'completed', phase: 'finalizing', startedAt: 1, lastEventAt: 2, completedAt: 2, tools: [] },
        },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => (persisted ? persistedMessages : { thread: { id: 't1' }, messages: [] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        return { ok: true, status: 200, body: new ReadableStream({ start(c) { streamController = c; } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    const { container, rerender } = render(
      <ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} backendActiveThreadIds={new Set()} />,
    );

    await userEvent.type(screen.getByTestId('chat-input'), 'hi there');
    await userEvent.click(screen.getByTestId('send-button'));

    // Backend accepts the run, then the stream connection drops (cold-start "Load failed").
    await waitFor(() => expect(streamController).toBeDefined());
    await act(async () => {
      streamController.enqueue(encoder.encode(`${JSON.stringify({ kind: 'run_start', run: { runId: 'run-1', threadId: 't1', startedAt: 1 } })}\n`));
    });
    await act(async () => {
      streamController.error(new TypeError('Load failed'));
    });

    // The optimistic user prompt is shown exactly once so far.
    await waitFor(() => expect(container.querySelectorAll('[data-chat-role="user"]').length).toBe(1));

    // The backend run is still alive; the parent marks the thread active and the
    // history now includes the persisted copy. The re-attach poller adopts it.
    persisted = true;
    rerender(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} backendActiveThreadIds={new Set(['t1'])} />);

    // Once the poller reconciles (the persisted assistant reply renders), the
    // prompt must still appear exactly once — not duplicated across the
    // persisted history and the stale optimistic buffer.
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument(), { timeout: 4000 });
    expect(container.querySelectorAll('[data-chat-role="user"]').length).toBe(1);
  }, 15000);

  it('keeps the just-sent prompt visible when a stream drops on a thread with prior history', async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    // Existing thread: one completed prior turn. The backend only persists a
    // new turn at run_end, so during a dropped run the history stays stale.
    const priorHistory = {
      thread: { id: 't1' },
      messages: [
        { id: 'user-0', role: 'user', content: 'earlier question', timestamp: 1 },
        { id: 'assistant-0', role: 'assistant', content: 'earlier answer', timestamp: 2, run: { runId: 'run-0', threadId: 't1', status: 'completed', phase: 'finalizing', startedAt: 1, lastEventAt: 2, completedAt: 2, tools: [] } },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') return { ok: true, json: async () => priorHistory } as Response;
      if (url === '/api/threads/t1/messages/stream') {
        return { ok: true, status: 200, body: new ReadableStream({ start(c) { streamController = c; } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} backendActiveThreadIds={new Set()} />);
    await screen.findByText('earlier question');

    await userEvent.type(screen.getByTestId('chat-input'), 'brand new prompt');
    await userEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => expect(streamController).toBeDefined());
    await act(async () => {
      streamController.enqueue(encoder.encode(`${JSON.stringify({ kind: 'run_start', run: { runId: 'run-2', threadId: 't1', startedAt: 3 } })}\n`));
    });
    await act(async () => {
      streamController.error(new TypeError('Load failed'));
    });

    // The prompt must NOT vanish just because stale history (older turn) exists;
    // the persisted copy of this turn isn't written until run_end.
    await waitFor(() => expect(screen.getByText('brand new prompt')).toBeInTheDocument());
    // And no hard error banner for a transport drop after the run started.
    expect(screen.queryByText('Load failed')).not.toBeInTheDocument();
  }, 15000);

  it('loads the completed turn when a fast re-attached run finishes between polls', async () => {
    // Mirrors the fast-run cold-start case: the backend marks the thread active
    // but persists nothing until run_end, so the poller only ever sees empty
    // history and then stops when the run leaves the active set. The final
    // reconciliation must still fetch the completed turn.
    let done = false;
    const completed = {
      thread: { id: 't1' },
      messages: [
        { id: 'u1', role: 'user', content: 'Hey GLM!', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'the reply', timestamp: 2, run: { runId: 'r1', threadId: 't1', status: 'completed', phase: 'finalizing', startedAt: 1, lastEventAt: 2, completedAt: 2, tools: [] } },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') return { ok: true, json: async () => (done ? completed : { thread: { id: 't1' }, messages: [] }) } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    });

    // Backend reports the thread active (run in flight), but history is empty.
    const { rerender } = render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} backendActiveThreadIds={new Set(['t1'])} />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeDisabled());

    // Run finishes: it's persisted now and drops out of the active set.
    done = true;
    rerender(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} backendActiveThreadIds={new Set()} />);

    // The completed reply must render via the final reconciliation load.
    await waitFor(() => expect(screen.getByText('the reply')).toBeInTheDocument(), { timeout: 4000 });
  }, 15000);

  it('renders a terminal fallback question and submits one readable continuation turn', async () => {
    const encoder = new TextEncoder();
    const ask = JSON.stringify({ questions: [{
      id: 'scope', header: 'Scope', question: 'Which scope?', allowOther: false,
      options: [{ value: 'small', label: 'Small' }, { value: 'full', label: 'Full' }],
    }] });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [{ id: 'assistant-1', role: 'assistant', content: `Choose a scope.\n\n\`\`\`ask\n${ask}\n\`\`\``, timestamp: 1 }] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'done' })}\n`)); controller.close(); } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock;

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    expect(await screen.findByText('Choose a scope.')).toBeInTheDocument();
    expect(screen.queryByText(/```ask/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Full' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/messages/stream'))).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Scope: Full')).toBeInTheDocument());
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.queryByText('Which scope?')).not.toBeInTheDocument();
    const streamCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/messages/stream'))!;
    expect(JSON.parse(String((streamCall[1] as RequestInit).body))).toMatchObject({ content: 'Scope: Full' });
  });

  it('disables one fallback card immediately while its continuation is in flight', async () => {
    const ask = JSON.stringify({ questions: [{
      id: 'scope', header: 'Scope', question: 'Which scope?', allowOther: false,
      options: [{ value: 'small', label: 'Small' }, { value: 'full', label: 'Full' }],
    }] });
    let streamCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [{ id: 'assistant-1', role: 'assistant', content: `\`\`\`ask\n${ask}\n\`\`\``, timestamp: 1 }] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        streamCalls += 1;
        return { ok: true, status: 200, body: new ReadableStream({ start() {} }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Full' }));
    const submitButton = screen.getByRole('button', { name: 'Submit answers' });
    await userEvent.click(submitButton);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Submitting…' }));
    expect(streamCalls).toBe(1);
  });

  it('shows a fallback continuation error on its card and allows retry', async () => {
    const ask = JSON.stringify({ questions: [{
      id: 'scope', header: 'Scope', question: 'Which scope?', allowOther: false,
      options: [{ value: 'small', label: 'Small' }, { value: 'full', label: 'Full' }],
    }] });
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [{ id: 'assistant-1', role: 'assistant', content: `\`\`\`ask\n${ask}\n\`\`\``, timestamp: 1 }] }) } as Response;
      }
      if (url === '/api/threads/t1/messages/stream') {
        return { ok: false, status: 503, body: null, json: async () => ({ error: 'Continuation unavailable' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Full' }));
    const submitButton = screen.getByRole('button', { name: 'Submit answers' });
    const card = submitButton.closest('form')!;
    await userEvent.click(submitButton);

    await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('Continuation unavailable'));
    expect(within(card).getByRole('button', { name: 'Submit answers' })).toBeEnabled();
  });

  it('keeps ordinary Markdown and malformed or non-terminal ask fences as text', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [] }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [
          { id: 'a1', role: 'assistant', content: 'A. Small\nB. Full', timestamp: 1 },
          { id: 'a2', role: 'assistant', content: '```ask\n{broken}\n```', timestamp: 2 },
          { id: 'a3', role: 'assistant', content: '```ask\n{"questions":[]}\n```\nAfterward', timestamp: 3 },
        ] }) } as Response;
      }
      return { ok: true, json: async () => ({ busy: false }) } as Response;
    });

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    expect(await screen.findByText(/A\. Small/)).toBeInTheDocument();
    expect(screen.getByText(/\{broken\}/)).toBeInTheDocument();
    expect(screen.getByText(/Afterward/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit answers' })).not.toBeInTheDocument();
  });

  it('opens an artifact preview rail from an assistant-generated file path', async () => {
    const filePath = '/Users/k-sym/Projects/nexus/project_docs/design/preview.md';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [] }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [
          { id: 'assistant-1', role: 'assistant', content: `Spec written to ${filePath}`, timestamp: 1 },
        ] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/files/preview')) {
        return { ok: true, json: async () => ({
          path: filePath,
          name: 'preview.md',
          mimeType: 'text/markdown',
          kind: 'text',
          size: 24,
          content: '# Preview\n\nBuilt notes.',
        }) } as Response;
      }
      return { ok: true, json: async () => ({ busy: false }) } as Response;
    });
    global.fetch = fetchMock;

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    await userEvent.click(await screen.findByRole('button', { name: `Preview preview.md` }));

    expect(await screen.findByRole('complementary', { name: 'File preview' })).toBeInTheDocument();
    expect(await screen.findByText(/Built notes\./)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/p1/files/preview?path=${encodeURIComponent(filePath)}`,
      expect.anything(),
    );
  });

  it('opens an artifact preview rail from an assistant-generated relative image path', async () => {
    const filePath = 'output/stick-man-640x480.png';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/models') return { ok: true, json: async () => ({ models: [] }) } as Response;
      if (url === '/api/threads/t1') {
        return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [
          { id: 'assistant-1', role: 'assistant', content: `Created: \`${filePath}\``, timestamp: 1 },
        ] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/files/preview')) {
        return { ok: true, json: async () => ({
          path: filePath,
          name: 'stick-man-640x480.png',
          mimeType: 'image/png',
          kind: 'image',
          size: 128,
          data: 'iVBORw0KGgo=',
        }) } as Response;
      }
      return { ok: true, json: async () => ({ busy: false }) } as Response;
    });
    global.fetch = fetchMock;

    render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview stick-man-640x480.png' }));

    expect(await screen.findByRole('complementary', { name: 'File preview' })).toBeInTheDocument();
    expect(await screen.findByAltText('stick-man-640x480.png')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/p1/files/preview?path=${encodeURIComponent(filePath)}`,
      expect.anything(),
    );
  });

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
