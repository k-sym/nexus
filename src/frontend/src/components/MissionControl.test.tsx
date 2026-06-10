import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MissionControl from './MissionControl';

const status = {
  memory: { ok: true, memories: 0, jobs: { pending: 0, dead: 0 }, models: { gen: true, embed: true, rerank: true } },
  models: [],
  activity: { running: [], recent: [] },
};

describe('MissionControl', () => {
  it('renders the three stats cards as placeholders', () => {
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
    expect(screen.getByText('codexbar session · 5h rolling')).toBeInTheDocument();
    expect(screen.getByText('codexbar session · weekly')).toBeInTheDocument();
    expect(screen.getByText('codexbar credit balance')).toBeInTheDocument();
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
