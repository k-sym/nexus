import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ModelCurationSection } from './ModelCurationSection';

const response = {
  models: [{ provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet', configured: true }],
  allModels: [
    { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet', configured: true },
    { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT 5.4 Codex', configured: true },
    { provider: 'google', id: 'gemini-pro', name: 'Gemini Pro', configured: false },
  ],
  enabledModelKeys: ['anthropic/claude-sonnet-4-5'],
  customized: true,
};

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
  });
});

describe('ModelCurationSection', () => {
  it('renders full Pi catalog with enabled switch state', async () => {
    render(<ModelCurationSection />);
    expect(await screen.findByText('Claude Sonnet')).toBeInTheDocument();
    expect(screen.getByText('GPT 5.4 Codex')).toBeInTheDocument();
    expect(screen.getByText(/3 total/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Claude Sonnet/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /GPT 5.4 Codex/i })).not.toBeChecked();
  });

  it('saves when a model is toggled', async () => {
    render(<ModelCurationSection />);
    const toggle = await screen.findByRole('switch', { name: /GPT 5.4 Codex/i });
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith('/api/models/curation', expect.objectContaining({ method: 'PUT' })),
    );
  });

  it('deselects all models in one action', async () => {
    render(<ModelCurationSection />);
    await screen.findByText('Claude Sonnet');

    await userEvent.click(screen.getByRole('button', { name: /Deselect all/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith(
        '/api/models/curation',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ enabledModelKeys: [] }),
        }),
      ),
    );
  });
});
