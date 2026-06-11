import { render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import MissionControl from './MissionControl';

const status = {
  memory: { ok: true, memories: 0, jobs: { pending: 0, dead: 0 }, models: { gen: true, embed: true, rerank: true } },
  models: [],
  stats: {
    claude: {
      ok: true,
      value: '100%',
      caption: 'session remaining · resets 11 Jun, 02:00',
      source: 'claude-statusline-cache',
      sampledAt: '2026-06-11T10:56:00.000Z',
      windows: {
        session: { usedPercent: 0, remainingPercent: 100, resetLabel: '11 Jun, 02:00', windowMinutes: 300 },
        weekly: { usedPercent: 12, remainingPercent: 88, resetLabel: '14 Jun, 23:00', windowMinutes: 10080 },
      },
    },
    codex: {
      ok: true,
      value: '45%',
      caption: 'session remaining · resets 11 Jun, 03:32',
      source: 'codex-web',
      sampledAt: '2026-06-11T10:56:00.000Z',
      windows: {
        session: { usedPercent: 55, remainingPercent: 45, resetLabel: '11 Jun, 03:32', windowMinutes: 300 },
        weekly: { usedPercent: 87, remainingPercent: 13, resetLabel: '11 Jun, 07:38', windowMinutes: 10080 },
      },
    },
    openrouter: { ok: true, value: '$12.35', caption: 'credit balance', source: 'live', sampledAt: '2026-06-11T10:56:00.000Z' },
  },
  activity: { running: [], recent: [] },
};

describe('MissionControl', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the three CodexBar stats cards', () => {
    vi.setSystemTime(new Date('2026-06-11T11:00:00.000Z'));
    render(
      <MissionControl
        status={status as any}
        loading={false}
        onRefresh={() => {}}
        onSelectAgent={() => {}}
      />,
    );
    expect(screen.getByText('Claude Stats')).toBeInTheDocument();
    expect(screen.getByText('Codex Stats')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter Stats')).toBeInTheDocument();
    expect(screen.getAllByText('Session')).toHaveLength(2);
    expect(screen.getAllByText('Weekly')).toHaveLength(2);
    expect(screen.getByText('55% used')).toBeInTheDocument();
    expect(screen.getByText('87% used')).toBeInTheDocument();
    expect(screen.getByText('$12.35')).toBeInTheDocument();
    expect(screen.getByText('Resets 11 Jun, 03:32')).toBeInTheDocument();
    expect(screen.getAllByText('Updated 4 min ago')).toHaveLength(3);
  });

  it('renders the Stats section above the Models section', () => {
    render(
      <MissionControl
        status={status as any}
        loading={false}
        onRefresh={() => {}}
        onSelectAgent={() => {}}
      />,
    );
    const stats = screen.getByText('Stats');
    // The status strip has a "Models" Card before the Models section, so
    // grab the LAST "Models" element (the section header) for the order check.
    const modelsSection = screen.getAllByText('Models').pop()!;
    expect(stats.compareDocumentPosition(modelsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not show token data in the recent activity rows', () => {
    render(
      <MissionControl
        status={{
          ...status,
          activity: {
            running: [],
            recent: [
              { id: '1', task_title: 'Sample task', provider: 'anthropic', model: 'sonnet', status: 'completed', duration_ms: 1234 },
            ],
          },
        } as any}
        loading={false}
        onRefresh={() => {}}
        onSelectAgent={() => {}}
      />,
    );
    expect(screen.getByText('Sample task')).toBeInTheDocument();
    expect(screen.queryByText(/tok/i)).not.toBeInTheDocument();
  });
});
