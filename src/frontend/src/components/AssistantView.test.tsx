import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AssistantView from './AssistantView';

vi.mock('../api-base', () => ({
  apiFetch: vi.fn(async (url: string) => {
    if (url === '/api/assistant/thread') {
      return {
        ok: true,
        json: async () => ({ id: 'global', messages: [] }),
      } as Response;
    }
    if (url === '/api/assistant/messages/stream') {
      return {
        ok: false,
        json: async () => ({ error: 'Assistant URL and key must be configured in Settings.' }),
      } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }),
}));

describe('AssistantView', () => {
  it('renders a project-independent assistant chat', async () => {
    render(<AssistantView />);

    expect(await screen.findByRole('heading', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message Assistant...')).toBeInTheDocument();
    expect(screen.getByText('Send a message to start.')).toBeInTheDocument();
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
});
