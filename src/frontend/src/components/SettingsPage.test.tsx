import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import SettingsPage from './SettingsPage';

vi.mock('../api', () => ({
  api: {
    settings: {
      get: vi.fn(async () => ({
        server: { port: 4173, url: '', token: '${NEXUS_BACKEND_TOKEN}' },
        assistant: { url: 'https://assistant.example.test/v1', api_key: '${ASSISTANT_API_KEY}' },
        models: { local: { base_url: '', api_key: '', display_name: 'Local Model', chat_model: '', supports_images: false } },
        jira: { enabled: false, user: '', instance: '', project: '', poll_minutes: 15 },
      })),
      update: vi.fn(async (config) => config),
      testLocalModel: vi.fn(async () => ({
        ok: true,
        message: 'Model responded.',
        models: ['qwen2.5-coder:7b'],
        modelFound: true,
      })),
    },
    trust: {
      get: vi.fn(async () => ({
        services: [], storage: [], secrets: {}, outbound: [],
        memory: {
          namespaces: ['nexus'],
          recall: { mode: 'on_demand', tool: 'memory_recall', maxMemories: 5, tokenBudget: 1000 },
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

  it('shows editable Connection fields when the backend is local', async () => {
    render(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    // Masked token env-ref is shown as-is (not a real secret).
    expect(screen.getByDisplayValue('${NEXUS_BACKEND_TOKEN}')).toBeInTheDocument();
    // Ownership groups are present, and the server group is unqualified when the
    // backend is this machine — there is no other host to name (#167).
    expect(screen.getByRole('heading', { name: 'This device' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server' })).toBeInTheDocument();
  });

  it('shows read-only connection info when this device is a thin client', async () => {
    (window as { __NEXUS_API__?: string }).__NEXUS_API__ = 'https://baker-pro.taileea629.ts.net:8444/api';
    try {
      render(<SettingsPage />);
      expect(await screen.findByRole('heading', { name: 'Connection' })).toBeInTheDocument();
      // The real connection target (sans /api) is shown, and editing is disabled.
      expect(screen.getByText('https://baker-pro.taileea629.ts.net:8444')).toBeInTheDocument();
      expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
      // #167: the page has to say WHOSE config.yaml it edits, because on a thin
      // client it is another machine's and nothing else on screen reveals that.
      expect(screen.getByText(/Editing/)).toHaveTextContent(
        'Editing config.yaml on baker-pro.taileea629.ts.net:8444, not this device.',
      );
      expect(
        screen.getByRole('heading', { name: 'Server — baker-pro.taileea629.ts.net:8444' }),
      ).toBeInTheDocument();
    } finally {
      delete (window as { __NEXUS_API__?: string }).__NEXUS_API__;
    }
  });

  it('mounts trust and privacy separately from editable settings', async () => {
    render(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Trust & Privacy' })).toBeInTheDocument();
  });

  it('tests the local model server with the unsaved settings values', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const modelInput = await screen.findByLabelText('Chat model id');
    await user.type(screen.getByLabelText('Base URL'), 'http://127.0.0.1:8081/v1');
    await user.type(modelInput, 'qwen2.5-coder:7b');
    await user.click(screen.getByRole('button', { name: 'Test endpoint' }));

    await waitFor(() => {
      expect(api.settings.testLocalModel).toHaveBeenCalledWith({
        base_url: 'http://127.0.0.1:8081/v1',
        api_key: '',
        chat_model: 'qwen2.5-coder:7b',
      });
    });
    expect(await screen.findByText('Model responded.')).toBeInTheDocument();
  });

  it('saves a display name separately from a path-like local model id', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.clear(await screen.findByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Local Model');
    await user.type(screen.getByLabelText('Chat model id'), '/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(api.settings.update).toHaveBeenCalledWith(expect.objectContaining({
        models: expect.objectContaining({
          local: expect.objectContaining({
            display_name: 'Local Model',
            chat_model: '/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf',
          }),
        }),
      }));
    });
  });

  it('saves the local model image input capability toggle', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'Image input Disabled' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(api.settings.update).toHaveBeenCalledWith(expect.objectContaining({
        models: expect.objectContaining({
          local: expect.objectContaining({
            supports_images: true,
          }),
        }),
      }));
    });
  });
});
