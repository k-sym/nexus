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
