import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';

vi.mock('../api', () => ({
  api: {
    settings: {
      get: vi.fn(async () => ({
        assistant: { url: 'https://assistant.example.test/v1', api_key: '${ASSISTANT_API_KEY}' },
        models: { local: { base_url: '', api_key: '' } },
        memory: { auto_inject: { enabled: true, max_memories: 5, token_budget: 1000 } },
        jira: { enabled: false, user: '', instance: '', project: '', poll_minutes: 15 },
      })),
      update: vi.fn(async (config) => config),
    },
    trust: {
      get: vi.fn(async () => ({
        services: [], storage: [], secrets: {}, outbound: [],
        memory: {
          namespaces: ['nexus'],
          autoInject: { enabled: true, maxMemories: 5, tokenBudget: 1000 },
          archive: { mode: 'manual', destination: 'nexus', removesHotThreadAfterSuccess: true },
        },
        telemetry: { applicationTelemetry: false, statement: 'No application telemetry' },
      })),
      rebuildMemory: vi.fn(),
      clearNexusMemory: vi.fn(),
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

  it('renders assistant URL and key settings', async () => {
    render(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://assistant.example.test/v1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('${ASSISTANT_API_KEY}')).toBeInTheDocument();
  });

  it('mounts trust and privacy separately from editable settings', async () => {
    render(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Trust & Privacy' })).toBeInTheDocument();
  });
});
