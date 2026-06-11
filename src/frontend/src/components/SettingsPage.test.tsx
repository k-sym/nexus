import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';

vi.mock('../api', () => ({
  api: {
    settings: {
      get: vi.fn(async () => ({
        models: { local: { base_url: '', api_key: '' } },
        memory: { auto_inject: { enabled: true, max_memories: 5, token_budget: 1000 } },
        jira: { enabled: false, user: '', instance: '', project: '', poll_minutes: 15 },
      })),
      update: vi.fn(async (config) => config),
    },
  },
}));

vi.mock('./PiAuthSection', () => ({
  PiAuthSection: () => <div>Provider auth controls</div>,
}));

vi.mock('./ModelCurationSection', () => ({
  ModelCurationSection: () => <div>Model curation controls</div>,
}));

describe('SettingsPage', () => {
  it('keeps the scroll container full width instead of centered like an embedded frame', async () => {
    const { container } = render(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    const scrollContainer = container.firstElementChild;

    expect(scrollContainer).toHaveClass('h-full', 'overflow-y-auto');
    expect(scrollContainer).not.toHaveClass('max-w-2xl', 'mx-auto');
  });
});
