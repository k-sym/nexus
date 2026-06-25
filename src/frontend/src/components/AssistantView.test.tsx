import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantView from './AssistantView';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('../api-base', () => ({
  apiFetch: apiFetchMock,
}));

apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
  if (url === '/api/assistant/thread' && init?.method === 'DELETE') {
    return { ok: true, json: async () => ({ ok: true, id: 'global' }) } as Response;
  }
  if (url === '/api/assistant/thread') {
    return { ok: true, json: async () => ({ id: 'global', messages: [] }) } as Response;
  }
  if (url === '/api/assistant/messages/stream') {
    return {
      ok: false,
      json: async () => ({ error: 'Assistant URL and key must be configured in Settings.' }),
    } as Response;
  }
  return { ok: true, json: async () => ({ ok: true }) } as Response;
});

describe('AssistantView', () => {
  const originalConfirm = window.confirm;
  let confirmSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    apiFetchMock.mockClear();
    confirmSpy = vi.fn(() => true);
    window.confirm = confirmSpy;
  });

  afterEach(() => {
    window.confirm = originalConfirm;
  });

  it('renders a project-independent assistant chat with the New Session button disabled when empty', async () => {
    render(<AssistantView />);

    expect(await screen.findByRole('heading', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message Assistant...')).toBeInTheDocument();
    expect(screen.getByText(/Send a message to start/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Session/i })).toBeDisabled();
  });

  it('shows missing configuration errors returned by the assistant stream route', async () => {
    render(<AssistantView />);

    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: 'Run this overnight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Assistant URL and key must be configured in Settings.');
    });
    expect(screen.getByDisplayValue('Run this overnight')).toBeInTheDocument();
  });

  it('clears the session when the user types /new instead of sending it as a message', async () => {
    render(<AssistantView />);

    const input = await screen.findByPlaceholderText('Message Assistant...');
    fireEvent.change(input, { target: { value: '/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/thread', { method: 'DELETE' });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Message Assistant...')).toHaveValue('');
    });
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/assistant/messages/stream', expect.anything());
  });

  it('clears the session via the New Session button after confirming', async () => {
    apiFetchMock.mockImplementationOnce(async (url: string) => {
      if (url === '/api/assistant/thread') {
        return {
          ok: true,
          json: async () => ({
            id: 'global',
            messages: [
              { id: 'm1', role: 'user', content: 'hello', created_at: '2026-06-25T00:00:00Z' },
              { id: 'm2', role: 'assistant', content: 'hi there', created_at: '2026-06-25T00:00:01Z' },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    render(<AssistantView />);

    const newSession = await screen.findByRole('button', { name: /New Session/i });
    await waitFor(() => expect(newSession).not.toBeDisabled());
    fireEvent.click(newSession);

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/assistant/thread', { method: 'DELETE' });
    });
    expect(confirmSpy).toHaveBeenCalled();
  });
});
