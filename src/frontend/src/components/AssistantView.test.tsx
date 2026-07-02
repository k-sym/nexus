import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantView from './AssistantView';
import { confirmDialog } from '../lib/confirm';

vi.mock('../lib/confirm', () => ({ confirmDialog: vi.fn() }));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('../api-base', () => ({
  apiFetch: apiFetchMock,
}));

const sessions = [
  { id: 's1', title: 'Nightly checks', status: 'idle', updated_at: '2026-07-01T08:00:00.000Z', latestRun: null },
  { id: 's2', title: 'Release watch', status: 'running', updated_at: '2026-07-01T09:00:00.000Z', latestRun: { id: 'r2', status: 'running' } },
];

function streamResponse(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function ndjsonStreamResponse(events: any[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      c.close();
    },
  });
  return { ok: true, body, json: async () => ({}) } as unknown as Response;
}

function installDefaultMock() {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/assistant/sessions') {
      if (init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 's3', title: 'New Assistant Session', status: 'idle', updated_at: '2026-07-01T10:00:00.000Z' }),
        } as Response;
      }
      return { ok: true, json: async () => ({ sessions }) } as Response;
    }
    if (url === '/api/assistant/sessions/s1') {
      return {
        ok: true,
        json: async () => ({
          session: sessions[0],
          messages: [
            { id: 'm1', role: 'user', content: 'run checks', created_at: '2026-07-01T08:00:00.000Z' },
            { id: 'm2', role: 'assistant', content: 'checks queued', created_at: '2026-07-01T08:01:00.000Z' },
          ],
          latestRun: null,
        }),
      } as Response;
    }
    if (url === '/api/assistant/sessions/s2') {
      return {
        ok: true,
        json: async () => ({
          session: sessions[1],
          messages: [{ id: 'm3', role: 'user', content: 'watch releases', created_at: '2026-07-01T09:00:00.000Z' }],
          latestRun: { id: 'r2', status: 'running' },
        }),
      } as Response;
    }
    if (url === '/api/assistant/sessions/s3') {
      return {
        ok: true,
        json: async () => ({ session: { id: 's3', title: 'New Assistant Session', status: 'idle' }, messages: [], latestRun: null }),
      } as Response;
    }
    if (url === '/api/assistant/sessions/s1/messages/stream') {
      return streamResponse([
        { type: 'run_start', runId: 'r1', remoteRunId: 'remote-r1' },
        { type: 'text_delta', delta: 'done' },
        { type: 'complete', runId: 'r1', status: 'succeeded' },
      ]);
    }
    if (url === '/api/assistant/sessions/s1/runs') {
      return { ok: true, json: async () => ({ run: { id: 'r-bg', status: 'running' } }) } as Response;
    }
    if (url === '/api/assistant/sync') {
      return { ok: true, json: async () => ({ updated: 1 }) } as Response;
    }
    if (url === '/api/assistant/abort') {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  });
}

describe('AssistantView', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
    installDefaultMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders Assistant sessions and the selected session transcript', async () => {
    render(<AssistantView />);

    expect(await screen.findByRole('button', { name: /Nightly checks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release watch/i })).toBeInTheDocument();
    expect(await screen.findByText('checks queued')).toBeInTheDocument();
  });

  it('switches sessions from the session rail', async () => {
    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /Release watch/i }));

    expect(await screen.findByText('watch releases')).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s2');
  });

  it('creates a new Assistant session from the rail', async () => {
    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /New Session/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Assistant Session' }),
        headers: { 'Content-Type': 'application/json' },
      });
    });
    expect(await screen.findByText(/Send a message to start/)).toBeInTheDocument();
  });

  it('sends foreground messages to the selected Assistant session stream', async () => {
    render(<AssistantView />);

    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: 'Run now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s1/messages/stream', {
        method: 'POST',
        body: JSON.stringify({ content: 'Run now' }),
        headers: { 'Content-Type': 'application/json' },
      });
    });
    expect(await screen.findByText('done')).toBeInTheDocument();
  });

  it('starts a detached background run for the selected session', async () => {
    render(<AssistantView />);

    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: 'Run overnight' } });
    fireEvent.click(screen.getByRole('button', { name: /Background Handoff/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s1/runs', {
        method: 'POST',
        body: JSON.stringify({ content: 'Run overnight' }),
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  it('renames the selected Assistant session from the header', async () => {
    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /Rename Assistant session/i }));
    const titleInput = screen.getByDisplayValue('Nightly checks');
    fireEvent.change(titleInput, { target: { value: 'Renamed checks' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Renamed checks' }),
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  it('deletes the selected Assistant session from a visible delete control without a confirm dialog', async () => {
    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /Delete Assistant session/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm delete Assistant session/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s1', { method: 'DELETE' });
    });
    // The inline two-step control is self-contained; it must not route through confirmDialog.
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('attaches files to Assistant messages', async () => {
    render(<AssistantView />);

    const input = await screen.findByPlaceholderText('Message Assistant...');
    const dropTarget = screen.getByTestId('assistant-drop-target');
    const file = new File(['hello'], 'brief.txt', { type: 'text/plain' });
    fireEvent.drop(dropTarget, { dataTransfer: { files: [file], types: ['Files'] } });

    expect(await screen.findByTestId('pending-assistant-attachment')).toHaveTextContent('brief.txt');
    fireEvent.change(input, { target: { value: 'Read this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([url]) => url === '/api/assistant/sessions/s1/messages/stream');
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body.content).toBe('Read this');
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toMatchObject({ type: 'file', name: 'brief.txt', mimeType: 'text/plain' });
      expect(body.attachments[0].data).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('pending-assistant-attachment')).not.toBeInTheDocument();
    });
  });

  it('renders persisted user attachments', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/assistant/sessions') {
        return { ok: true, json: async () => ({ sessions: [sessions[0]] }) } as Response;
      }
      if (url === '/api/assistant/sessions/s1') {
        return {
          ok: true,
          json: async () => ({
            session: sessions[0],
            messages: [{
              id: 'm-attached',
              role: 'user',
              content: 'see attached',
              created_at: '2026-07-01T08:00:00.000Z',
              attachments: [{ type: 'file', name: 'brief.txt', mimeType: 'text/plain', data: 'aGVsbG8=', path: '/tmp/brief.txt' }],
            }],
            latestRun: null,
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    render(<AssistantView />);

    const bubble = await screen.findByText('see attached');
    expect(within(bubble.closest('[data-chat-role="user"]') as HTMLElement).getByText('brief.txt')).toBeInTheDocument();
  });

  it('clears the selected running session without calling the global abort endpoint', async () => {
    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /Release watch/i }));
    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: '/clear' } });
    // The session is running, so the composer shows Stop instead of Send;
    // submit via Enter (handleKeyDown → handleSend) to reach the /clear path.
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s2', { method: 'DELETE' });
    });
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/assistant/abort', { method: 'POST' });
  });

  it('keeps foreground Hermes runs visible and syncs while the remote run is still running', async () => {
    let started = false;
    let synced = false;
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/assistant/sessions') {
        return { ok: true, json: async () => ({ sessions: [sessions[0]] }) } as Response;
      }
      if (url === '/api/assistant/sessions/s1') {
        const active = started && !synced;
        return {
          ok: true,
          json: async () => ({
            session: { ...sessions[0], status: active ? 'running' : 'idle' },
            messages: synced
              ? [
                  { id: 'm4', role: 'user', content: 'Run now', created_at: '2026-07-01T10:00:00.000Z' },
                  { id: 'm5', role: 'assistant', content: 'Hermes finished.', created_at: '2026-07-01T10:01:00.000Z' },
                ]
              : [],
            latestRun: active ? { id: 'r-live', status: 'running' } : synced ? { id: 'r-live', status: 'succeeded' } : null,
          }),
        } as Response;
      }
      if (url === '/api/assistant/sessions/s1/messages/stream') {
        started = true;
        return streamResponse([
          { type: 'run_start', runId: 'r-live', remoteRunId: 'remote-live' },
          { type: 'complete', runId: 'r-live', status: 'running' },
        ]);
      }
      if (url === '/api/assistant/sync') {
        synced = true;
        return { ok: true, json: async () => ({ updated: 1 }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    render(<AssistantView />);

    const input = await screen.findByPlaceholderText('Message Assistant...');
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: 'Run now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Running...')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sync', { method: 'POST' });
    expect(screen.getByText('Hermes finished.')).toBeInTheDocument();
  });

  it('builds an AgentRunView from the structured NDJSON stream and accumulates text', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/assistant/sessions') return { ok: true, json: async () => ({ sessions: [{ id: 's1', title: 'S', status: 'idle' }] }) } as Response;
      if (url === '/api/assistant/sessions/s1') return { ok: true, json: async () => ({ session: { id: 's1', title: 'S', status: 'idle' }, messages: [], latestRun: null }) } as Response;
      if (url.endsWith('/messages/stream')) {
        return ndjsonStreamResponse([
          { kind: 'run_start', run: { runId: 'r1', threadId: 's1', startedAt: '2026-07-02T00:00:00.000Z', provider: 'assistant', model: 'hermes-agent' } },
          { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'Bash', args: { command: 'ls' } },
          { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'Bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done.' } },
          { kind: 'run_end', run: { runId: 'r1', threadId: 's1', completedAt: '2026-07-02T00:00:01.000Z', status: 'completed' } },
        ]);
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<AssistantView />);
    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: 'run ls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Task 5 renders the run via AgentRunCard/ToolActivity: once the run completes,
    // the tool timeline collapses into a summary row (the full "bash $ ls" row is
    // only shown while running or expanded; see the dedicated streaming test below).
    // The hook still accumulates streamed text into the draft assistant message.
    expect(await screen.findByText('Done.')).toBeInTheDocument();
    expect(await screen.findByText('1 tool call')).toBeInTheDocument();
    expect(await screen.findByText(/Completed/i)).toBeInTheDocument();
  });

  it('shows the run card tool row, the status strip, and a Stop button while streaming', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/assistant/sessions') return { ok: true, json: async () => ({ sessions: [{ id: 's1', title: 'S', status: 'idle' }] }) } as Response;
      if (url === '/api/assistant/sessions/s1') return { ok: true, json: async () => ({ session: { id: 's1', title: 'S', status: 'idle' }, messages: [], latestRun: null }) } as Response;
      if (url.endsWith('/messages/stream')) {
        // Stream stays "open" (no run_end) so the run is still active when we assert.
        return ndjsonStreamResponse([
          { kind: 'run_start', run: { runId: 'r1', threadId: 's1', startedAt: '2026-07-02T00:00:00.000Z', provider: 'assistant', model: 'hermes-agent' } },
          { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'Bash', args: { command: 'ls' } },
        ]);
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    render(<AssistantView />);
    const input = await screen.findByPlaceholderText('Message Assistant...');
    await userEvent.type(input, 'run ls');
    await userEvent.click(screen.getByRole('button', { name: /Send/i }));

    expect(await screen.findByText(/bash.*ls/i)).toBeInTheDocument();
    expect(await screen.findByTestId('run-status')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Stop current run' })).toBeInTheDocument();
  });

  it('renders remote Hermes sessions in the Assistant rail and imports on click', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/assistant/sessions') {
        return { ok: true, json: async () => ({ sessions: [
          { id: 'remote:remote-api-1', title: 'Remote API session', status: 'remote', remoteOnly: true, remote_session_id: 'remote-api-1', updated_at: '2026-07-02T10:00:00.000Z' },
        ] }) } as Response;
      }
      if (url === '/api/assistant/sessions/import') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ remoteSessionId: 'remote-api-1' });
        return { ok: true, json: async () => ({
          session: { id: 'local-imported', title: 'Remote API session', status: 'idle', remote_session_id: 'remote-api-1' },
          messages: [{ id: 'm1', role: 'assistant', content: 'imported transcript', created_at: '2026-07-02T10:02:00.000Z' }],
          latestRun: null,
        }) } as Response;
      }
      if (url === '/api/assistant/sessions/local-imported') {
        return { ok: true, json: async () => ({
          session: { id: 'local-imported', title: 'Remote API session', status: 'idle', remote_session_id: 'remote-api-1' },
          messages: [{ id: 'm1', role: 'assistant', content: 'imported transcript', created_at: '2026-07-02T10:02:00.000Z' }],
          latestRun: null,
        }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /Remote API session/i }));
    expect(await screen.findByText('imported transcript')).toBeInTheDocument();
  });

  it('marks remote-only Hermes sessions without changing local session controls', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/assistant/sessions') {
        return { ok: true, json: async () => ({ sessions: [
          { id: 'remote:remote-api-1', title: 'Remote API session', status: 'remote', remoteOnly: true, remote_session_id: 'remote-api-1' },
        ] }) } as Response;
      }
      return { ok: true, json: async () => ({ session: null, messages: [], latestRun: null }) } as Response;
    });

    render(<AssistantView />);

    const row = await screen.findByRole('button', { name: /Remote API session/i });
    expect(within(row).getByText('Remote')).toBeInTheDocument();
  });
});
