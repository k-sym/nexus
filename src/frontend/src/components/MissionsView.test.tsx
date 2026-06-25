import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MissionsView from './MissionsView';

vi.mock('../api', () => ({
  api: {
    missions: {
      listForProject: vi.fn().mockResolvedValue([
        { id: 'm1', project_id: 'p1', title: 'Triage tickets', description: '', kind: 'echo',
          config_json: '{}', pacing: 'fixed', interval_seconds: 3600, max_iterations: 10,
          max_wall_clock_seconds: null, max_tokens: null, run_window_start: null, run_window_end: null,
          status: 'paused', iteration_count: 0, tokens_used: 0, next_run_at: null, started_at: null,
          last_run_at: null, stopped_at: null, stop_reason: null,
          created_at: '2026-06-22T00:00:00Z', updated_at: '2026-06-22T00:00:00Z' },
      ]),
      runs: vi.fn().mockResolvedValue([]),
      resume: vi.fn(), pause: vi.fn(), stop: vi.fn(), create: vi.fn(), delete: vi.fn(),
    },
  },
}));

const projects = [
  { id: 'p1', slug: 'p1', name: 'Project One', description: '', repo_path: '/tmp/p1',
    config_json: '{}', git_remote: '', created_at: '', updated_at: '' },
  { id: 'p2', slug: 'p2', name: 'Baker', description: '', repo_path: '/tmp/p2',
    config_json: '{}', git_remote: '', created_at: '', updated_at: '' },
];

describe('MissionsView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists missions for the selected project', async () => {
    render(<MissionsView projects={projects as never} />);
    await waitFor(() => expect(screen.getByText('Triage tickets')).toBeInTheDocument());
  });

  it('uses current accent styling instead of legacy purple mission controls', async () => {
    render(<MissionsView projects={projects as never} />);

    const newButton = screen.getByRole('button', { name: /New/ });
    expect(newButton).toHaveClass('accent-button');
    expect(newButton).not.toHaveClass('bg-indigo-600');

    const mission = await screen.findByRole('button', { name: /Triage tickets/ });
    expect(mission).not.toHaveClass('border-indigo-500/60');
  });

  it('uses a themed project picker instead of the browser select in the header', async () => {
    render(<MissionsView projects={projects as never} />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /Mission project Project One/i });
    expect(trigger).toHaveClass('triage-project-trigger');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');

    fireEvent.click(trigger);
    const listbox = screen.getByRole('listbox', { name: /Mission project/i });
    expect(listbox).toHaveClass('triage-project-listbox');

    fireEvent.click(screen.getByRole('option', { name: 'Baker' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Mission project Baker/i })).toBeInTheDocument());
  });
});
