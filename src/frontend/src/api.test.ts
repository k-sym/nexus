import { beforeEach, describe, expect, it, vi } from 'vitest';

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
