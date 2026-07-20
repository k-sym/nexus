import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type TrustSnapshot } from '../api';
import { TrustPrivacySection } from './TrustPrivacySection';

vi.mock('../api', () => ({
  api: {
    trust: {
      get: vi.fn(),
      rebuildMemory: vi.fn(),
      clearNexusMemory: vi.fn(),
    },
  },
}));

const snapshot: TrustSnapshot = {
  services: [{ name: 'Backend', url: 'http://127.0.0.1:4100', loopback: true }],
  storage: [
    { name: 'Pi credentials', path: '~/.nexus/auth.json', role: 'credentials' },
    { name: 'Memory vault', path: '~/Vault', role: 'canonical' },
  ],
  secrets: {
    pi: { configured: true, source: 'pi-auth-file', credentialType: 'oauth', value: 'raw-secret' } as never,
    jira: { configured: false, source: 'absent' },
  },
  memory: {
    namespaces: ['nexus', 'global'],
    recall: { mode: 'on_demand', tool: 'memory_recall', maxMemories: 5, tokenBudget: 1000 },
    archive: { mode: 'manual', destination: 'nexus', removesHotThreadAfterSuccess: true },
  },
  outbound: [{ name: 'Model providers', destination: 'Configured endpoints', sends: ['prompts', 'context'], enabled: true }],
  telemetry: { applicationTelemetry: false, statement: 'No application telemetry' },
};

const trust = api.trust as {
  get: ReturnType<typeof vi.fn>;
  rebuildMemory: ReturnType<typeof vi.fn>;
  clearNexusMemory: ReturnType<typeof vi.fn>;
};

describe('TrustPrivacySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trust.get.mockResolvedValue(snapshot);
    trust.rebuildMemory.mockResolvedValue({ scanned: 3, inserted: 0, updated: 2, noop: 1, removed: 0, reindexed: 2, queued: 2 });
    trust.clearNexusMemory.mockResolvedValue({ namespace: 'nexus', deleted: 2, failed: 0, paths: [], failures: [] });
  });

  it('shows loading then renders boundaries without displaying secret values', async () => {
    let resolve!: (value: TrustSnapshot) => void;
    trust.get.mockReturnValue(new Promise<TrustSnapshot>((done) => { resolve = done; }));
    render(<TrustPrivacySection />);

    expect(screen.getByText('Loading trust information…')).toBeInTheDocument();
    resolve(snapshot);

    expect(await screen.findByText('No application telemetry')).toBeInTheDocument();
    expect(screen.getByText('~/.nexus/auth.json')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Memory boundaries' })).toBeInTheDocument();
    expect(screen.queryByText('raw-secret')).not.toBeInTheDocument();
  });

  it('describes memory recall as agent-initiated rather than automatic', async () => {
    render(<TrustPrivacySection />);

    // This panel is the user's account of what happens to their data, so it has
    // to match the runtime: nothing is read from the vault unless the agent
    // calls memory_recall during a turn.
    expect(await screen.findByText(
      'On demand · agent calls memory_recall · up to 5 memories / 1000 tokens',
    )).toBeInTheDocument();
    expect(screen.queryByText(/Auto-injection/)).not.toBeInTheDocument();
  });

  it('keeps the surface available when trust information cannot load', async () => {
    trust.get.mockRejectedValue(new Error('backend unavailable'));
    render(<TrustPrivacySection />);

    expect(await screen.findByText('Trust information is currently unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trust & Privacy' })).toBeInTheDocument();
  });

  it('requires exact confirmation before clear and refreshes and resets after success', async () => {
    const user = userEvent.setup();
    render(<TrustPrivacySection />);
    const clear = await screen.findByRole('button', { name: 'Clear Nexus memory' });
    const confirmation = screen.getByLabelText('Confirmation phrase');

    expect(clear).toBeDisabled();
    await user.type(confirmation, 'CLEAR NEXUS MEMOR');
    expect(clear).toBeDisabled();
    await user.type(confirmation, 'Y');
    expect(clear).toBeEnabled();
    await user.click(clear);

    expect(trust.clearNexusMemory).toHaveBeenCalledWith('CLEAR NEXUS MEMORY');
    await waitFor(() => expect(trust.get).toHaveBeenCalledTimes(2));
    expect(confirmation).toHaveValue('');
    expect(await screen.findByText('Nexus memory cleared: 2 deleted.')).toBeInTheDocument();
  });

  it('refreshes after a successful rebuild', async () => {
    const user = userEvent.setup();
    render(<TrustPrivacySection />);
    await user.click(await screen.findByRole('button', { name: 'Rebuild memory index' }));

    expect(trust.rebuildMemory).toHaveBeenCalledOnce();
    await waitFor(() => expect(trust.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Memory index rebuilt: 3 scanned, 0 inserted, 2 updated, 1 unchanged, 0 removed, 2 reindexed, 2 jobs queued.')).toBeInTheDocument();
  });

  it('reports a partial clear as an error and preserves confirmation for retry', async () => {
    trust.clearNexusMemory.mockResolvedValue({
      namespace: 'nexus', deleted: 2, failed: 1, paths: [],
      failures: [{ path: 'Nexus/a.md', error: 'Unable to delete canonical memory (EACCES)' }],
    });
    const user = userEvent.setup();
    render(<TrustPrivacySection />);
    const confirmation = await screen.findByLabelText('Confirmation phrase');
    await user.type(confirmation, 'CLEAR NEXUS MEMORY');
    await user.click(screen.getByRole('button', { name: 'Clear Nexus memory' }));

    expect(await screen.findByText('Nexus memory partially cleared: 2 deleted, 1 failed.')).toBeInTheDocument();
    expect(confirmation).toHaveValue('CLEAR NEXUS MEMORY');
    await waitFor(() => expect(trust.get).toHaveBeenCalledTimes(2));
  });

  it('reports operation failure and leaves the snapshot visible', async () => {
    trust.rebuildMemory.mockRejectedValue(new Error('daemon unavailable'));
    const user = userEvent.setup();
    render(<TrustPrivacySection />);
    await user.click(await screen.findByRole('button', { name: 'Rebuild memory index' }));

    expect(await screen.findByText('daemon unavailable')).toBeInTheDocument();
    expect(screen.getByText('No application telemetry')).toBeInTheDocument();
  });

  it('disables both maintenance controls while an operation is running', async () => {
    trust.rebuildMemory.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<TrustPrivacySection />);
    const rebuild = await screen.findByRole('button', { name: 'Rebuild memory index' });
    const clear = screen.getByRole('button', { name: 'Clear Nexus memory' });
    await user.type(screen.getByLabelText('Confirmation phrase'), 'CLEAR NEXUS MEMORY');
    await user.click(rebuild);

    expect(rebuild).toBeDisabled();
    expect(clear).toBeDisabled();
  });
});
