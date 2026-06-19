import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiffReviewPanel from './DiffReviewPanel';
import { api } from '../api';

const diffState = {
  ok: true as const,
  repo_path: '/repo',
  git_remote: 'git@github.com:k-sym/nexus.git',
  has_changes: true,
  summary: { files: 1, hunks: 1, added: 1, deleted: 0, staged_files: ['src/a.ts'], unstaged_files: [], untracked_files: [] },
  files: [{ path: 'src/a.ts', old_path: 'src/a.ts', new_path: 'src/a.ts', status: 'modified' as const, added: 1, deleted: 0, staged: true, hunks: [] }],
  hunks: [{ id: 'hunk-1', file: 'src/a.ts', header: '@@ -1,2 +1,3 @@', diff: '+const b = 2;', prompt: 'Review this change', staged: true, old_start: 1, new_start: 1, old_lines: 2, new_lines: 3 }],
};

describe('DiffReviewPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders no-changes state', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue({ ok: true, repo_path: '/repo', git_remote: '', has_changes: false, summary: { files: 0, hunks: 0, added: 0, deleted: 0, staged_files: [], unstaged_files: [], untracked_files: [] }, files: [], hunks: [] });
    render(<DiffReviewPanel projectId="project-1" task={null} onClose={vi.fn()} onTaskCreated={vi.fn()} onTaskAssigned={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText('No current tracked diff changes.')).toBeInTheDocument();
  });

  it('renders hunk actions and calls reviewAction for ask_reviewer', async () => {
    const gitDiff = vi.spyOn(api.projects, 'gitDiff').mockResolvedValue(diffState);
    const reviewAction = vi.spyOn(api.projects, 'reviewAction').mockResolvedValue({ ok: true, action: 'ask_reviewer', task: { id: 'task-new', project_id: 'project-1', title: 'Review hunk', status: 'review', assigned_agent: 'Reviewer', model_key: null } });
    const onTaskCreated = vi.fn();
    render(<DiffReviewPanel projectId="project-1" task={{ id: 'task-1', title: 'Source' } as any} onClose={vi.fn()} onTaskCreated={onTaskCreated} onTaskAssigned={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('+const b = 2;')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Ask reviewer/ }));
    expect(reviewAction).toHaveBeenCalledWith('project-1', { action: 'ask_reviewer', task_id: 'task-1', hunk_id: 'hunk-1' });
    expect(onTaskCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-new' }));
    gitDiff.mockRestore();
    reviewAction.mockRestore();
  });

  it('renders git error state', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue({ ok: false, reason: 'not_git_repo', message: 'Not a git repository', repo_path: '/repo', git_remote: '' });
    render(<DiffReviewPanel projectId="project-1" task={null} onClose={vi.fn()} onTaskCreated={vi.fn()} onTaskAssigned={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText(/^Git diff unavailable/)).toBeInTheDocument();
  });
});
