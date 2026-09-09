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

const thread = { id: 'thread-1', title: 'Fix the login bug' };

describe('DiffReviewPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders no-changes state', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue({ ok: true, repo_path: '/repo', git_remote: '', has_changes: false, summary: { files: 0, hunks: 0, added: 0, deleted: 0, staged_files: [], unstaged_files: [], untracked_files: [] }, files: [], hunks: [] });
    render(<DiffReviewPanel projectId="project-1" thread={null} onClose={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText('No current tracked diff changes.')).toBeInTheDocument();
  });

  it('offers one action per hunk — attach to this session — and seeds the thread with the result (#439 D12)', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue(diffState);
    const seed = { threadId: 'thread-1', prompt: 'Review this change', modelKey: 'anthropic/opus' };
    const reviewAction = vi.spyOn(api.projects, 'reviewAction').mockResolvedValue({ ok: true, action: 'attach_to_chat', seed });
    const onChatSeed = vi.fn();
    render(<DiffReviewPanel projectId="project-1" thread={thread} onClose={vi.fn()} onChatSeed={onChatSeed} />);

    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('+const b = 2;')).toBeInTheDocument();
    expect(screen.getByText('Session: Fix the login bug')).toBeInTheDocument();

    // The task-creating actions are gone.
    expect(screen.queryByRole('button', { name: /Ask reviewer/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Spawn fix task/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Assign reviewer/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Attach to this session' })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Attach to this session' }));
    expect(reviewAction).toHaveBeenCalledWith('project-1', { action: 'attach_to_chat', thread_id: 'thread-1', hunk_id: 'hunk-1', note: undefined });
    expect(onChatSeed).toHaveBeenCalledWith(seed);
  });

  it('forwards a typed note with the action', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue(diffState);
    const reviewAction = vi.spyOn(api.projects, 'reviewAction').mockResolvedValue({ ok: true, action: 'attach_to_chat' });
    render(<DiffReviewPanel projectId="project-1" thread={thread} onClose={vi.fn()} onChatSeed={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Note for src/a.ts'), 'focus on edge cases');
    await userEvent.click(screen.getByRole('button', { name: 'Attach to this session' }));
    expect(reviewAction).toHaveBeenCalledWith('project-1', { action: 'attach_to_chat', thread_id: 'thread-1', hunk_id: 'hunk-1', note: 'focus on edge cases' });
  });

  it('disables the action without a session', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue(diffState);
    render(<DiffReviewPanel projectId="project-1" thread={null} onClose={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Attach to this session' })).toBeDisabled();
  });

  it('closes on Escape', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue(diffState);
    const onClose = vi.fn();
    render(<DiffReviewPanel projectId="project-1" thread={thread} onClose={onClose} onChatSeed={vi.fn()} />);
    await screen.findByText('src/a.ts');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders git error state', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue({ ok: false, reason: 'not_git_repo', message: 'Not a git repository', repo_path: '/repo', git_remote: '' });
    render(<DiffReviewPanel projectId="project-1" thread={null} onClose={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText(/^Git diff unavailable/)).toBeInTheDocument();
  });
});
