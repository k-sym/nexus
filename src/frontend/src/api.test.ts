import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewActionRequest } from '@nexus/shared';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api-base', () => ({ apiFetch }));

import { api, linkThreadToMondayItem, unlinkThreadFromMondayItem } from './api';

describe('chat question API', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('posts answers to the native question endpoint', async () => {
    const answers = [{ questionId: 'scope', selected: ['full'] }];

    await api.chat.answerQuestion('thread / 1', 'call / 1', answers);

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/threads/thread%20%2F%201/questions/call%20%2F%201/answer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ answers }),
      }),
    );
  });

  it('fetches active chat run thread IDs', async () => {
    const response = {
      activeThreadIds: ['thread-1'],
      runs: [{
        threadId: 'thread-1',
        title: 'Needs scope',
        modelKey: 'openrouter/model',
        projectId: 'project-1',
        waitingForResponse: true,
        questionCount: 1,
      }],
    };
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => response,
    });

    await expect(api.chat.activeRuns()).resolves.toEqual(response);

    expect(apiFetch).toHaveBeenCalledWith('/api/chat/active-runs', expect.any(Object));
  });
});

describe('api.projects diff review', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('exposes gitDiff and reviewAction endpoints', async () => {
    const payload: ReviewActionRequest = { action: 'attach_to_chat', thread_id: 'thread-1', hunk_id: 'hunk-1' };

    await api.projects.gitDiff('project-1');
    await api.projects.reviewAction('project-1', payload);

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/projects/project-1/git/diff', expect.any(Object));
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/projects/project-1/review-actions', expect.objectContaining({ method: 'POST' }));
  });
});

describe('api.projects board (#439)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('reads the board projection, drafts and opens origin sessions', async () => {
    await api.projects.board('project-1');
    await api.projects.board('project-1', true);
    await api.projects.boardDraft('project-1', { kind: 'github', id: '439' });
    await api.projects.boardSession('project-1', { kind: 'monday', id: 'item-9', problem: 'Fix it', branchName: 'fix/it' });

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/projects/project-1/board', expect.any(Object));
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/projects/project-1/board?refresh=1', expect.any(Object));
    expect(apiFetch).toHaveBeenNthCalledWith(3, '/api/projects/project-1/board/draft', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'github', id: '439' }),
    }));
    expect(apiFetch).toHaveBeenNthCalledWith(4, '/api/projects/project-1/board/session', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'monday', id: 'item-9', problem: 'Fix it', branchName: 'fix/it' }),
    }));
  });

  it('no longer exposes the task or GitHub sync helpers', () => {
    expect((api as Record<string, unknown>).tasks).toBeUndefined();
    expect((api.projects as Record<string, unknown>).tasks).toBeUndefined();
    expect((api.projects as Record<string, unknown>).createTask).toBeUndefined();
    expect((api.projects as Record<string, unknown>).githubSync).toBeUndefined();
  });
});

describe('Monday session links (#439)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  it('links and unlinks by thread id', async () => {
    await linkThreadToMondayItem('project-1', 'thread-1', 'item-1');
    await unlinkThreadFromMondayItem('thread 1');

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/monday/links', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ project_id: 'project-1', thread_id: 'thread-1', item_id: 'item-1' }),
    }));
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/monday/links/thread%201', expect.objectContaining({ method: 'DELETE' }));
  });
});
