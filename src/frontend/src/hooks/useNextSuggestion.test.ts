import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useNextSuggestion } from './useNextSuggestion';

const MESSAGES = [
  { role: 'user', content: 'add a test' },
  { role: 'assistant', content: 'done' },
];

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ suggestion: 'run the tests' }),
  }) as unknown as Response);
});

describe('useNextSuggestion', () => {
  it('fetches a suggestion once a turn completes', async () => {
    const { result } = renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'm2', messages: MESSAGES, enabled: true }));
    await waitFor(() => expect(result.current.suggestion).toBe('run the tests'));
  });

  it('does not fetch while disabled', async () => {
    renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'm2', messages: MESSAGES, enabled: false }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not fetch without a completed turn', async () => {
    renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: null, messages: MESSAGES, enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends only user and assistant turns as { role, text }', async () => {
    renderHook(() => useNextSuggestion({
      sessionKey: 't1',
      turnKey: 'm2',
      messages: [...MESSAGES, { role: 'toolResult', content: 'noise' }, { role: 'user', content: '  ' }],
      enabled: true,
    }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.transcript).toEqual([
      { role: 'user', text: 'add a test' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('clears the suggestion when the session changes', async () => {
    const { result, rerender } = renderHook(
      (props: { sessionKey: string }) => useNextSuggestion({
        sessionKey: props.sessionKey, turnKey: 'm2', messages: MESSAGES, enabled: true,
      }),
      { initialProps: { sessionKey: 't1' } },
    );
    await waitFor(() => expect(result.current.suggestion).toBe('run the tests'));
    rerender({ sessionKey: 't2' });
    expect(result.current.suggestion).toBe('');
  });

  it('dismiss clears the suggestion and it does not come back for the same turn', async () => {
    const { result, rerender } = renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'm2', messages: MESSAGES, enabled: true }));
    await waitFor(() => expect(result.current.suggestion).toBe('run the tests'));
    act(() => result.current.dismiss());
    expect(result.current.suggestion).toBe('');
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.suggestion).toBe('');
  });

  it('stays silent when the request fails', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); });
    const { result } = renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'm2', messages: MESSAGES, enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.suggestion).toBe('');
  });
});
