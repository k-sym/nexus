import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewActionRequest } from '@nexus/shared';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api-base', () => ({ apiFetch }));

import { api } from './api';

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
    const payload: ReviewActionRequest = { action: 'ask_reviewer', task_id: 'task-1', hunk_id: 'hunk-1' };

    await api.projects.gitDiff('project-1');
    await api.projects.reviewAction('project-1', payload);

    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/projects/project-1/git/diff', expect.any(Object));
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/projects/project-1/review-actions', expect.objectContaining({ method: 'POST' }));
  });
});
