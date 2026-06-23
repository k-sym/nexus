import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const projects = [{ id: 'p1', slug: 'p1', name: 'Project One', description: '', repo_path: '/tmp/p1',
  config_json: '{}', git_remote: '', created_at: '', updated_at: '' }];

describe('MissionsView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists missions for the selected project', async () => {
    render(<MissionsView projects={projects as never} />);
    await waitFor(() => expect(screen.getByText('Triage tickets')).toBeInTheDocument());
  });
});
