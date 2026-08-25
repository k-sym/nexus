import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('../api-base', () => ({ apiFetch: apiFetchMock, apiUrl: (u: string) => u }));

import { useAssistantStream, type AssistantAttachment } from './useAssistantStream';

function res(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, statusText: '', json: async () => body } as unknown as Response;
}

// End-to-end through the hook: a sent image is cached and re-attached to the
// user turn after the transcript reloads TEXT-ONLY (as the real Hermes-backed
// transcript does).
describe('useAssistantStream attachment persistence', () => {
  it('re-attaches a sent image after a text-only reload', async () => {
    const sessionId = 's-int';
    const detail = { session: { id: sessionId, title: 'T', status: 'idle' }, messages: [] as unknown[], latestRun: null };

    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === `/api/assistant/sessions/${sessionId}` && method === 'GET') return Promise.resolve(res(detail));
      if (url === `/api/assistant/sessions/${sessionId}/messages/stream` && method === 'POST') {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              JSON.stringify({ kind: 'run_end', run: { runId: 'r1', threadId: sessionId, completedAt: 'y', status: 'completed' } }) + '\n'));
            c.close();
          },
        });
        return Promise.resolve({ ok: true, body, json: async () => ({}) } as unknown as Response);
      }
      return Promise.resolve(res({}));
    });

    const { result } = renderHook(() => useAssistantStream());
    await act(async () => { await result.current.loadSession(sessionId); });

    const img: AssistantAttachment = { type: 'image', data: 'Zm9v', mimeType: 'image/jpeg', name: 'p.jpg' };
    await act(async () => { await result.current.send('describe this', [img]); });

    // The backend now has the user turn — but TEXT-ONLY (no attachments field).
    detail.messages = [{ id: 'u1', role: 'user', content: 'describe this' }];
    await act(async () => { await result.current.loadSession(sessionId); });

    const user = result.current.messages.find((m) => m.role === 'user');
    expect(user?.attachments?.[0]).toMatchObject({ type: 'image', name: 'p.jpg', data: 'Zm9v' });
  });
});
