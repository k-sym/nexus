import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantView from './AssistantView';

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
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installDefaultMock();
  });

  it('renders Assistant sessions and the selected session transcript', async () => {
    render(<AssistantView />);

    expect(await screen.findByRole('button', { name: /Nightly checks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release watch/i })).toBeInTheDocument();
    expect(await screen.findByText('checks queued')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /Run in background/i }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s1/runs', {
        method: 'POST',
        body: JSON.stringify({ content: 'Run overnight' }),
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  it('clears the selected running session without calling the global abort endpoint', async () => {
    render(<AssistantView />);

    fireEvent.click(await screen.findByRole('button', { name: /Release watch/i }));
    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: '/clear' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/sessions/s2', { method: 'DELETE' });
    });
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/assistant/abort', { method: 'POST' });
  });
});
