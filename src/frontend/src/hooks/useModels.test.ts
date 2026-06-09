import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useModels, modelKey, parseModelKey } from './useModels';

const mockModels = [
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', provider: 'anthropic', reasoning: false },
  { id: 'gpt-5', name: 'GPT-5', provider: 'openai', reasoning: false },
];

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ models: mockModels }),
  });
});

describe('useModels', () => {
  it('fetches the model list on mount', async () => {
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.models.length).toBe(2));
    expect(result.current.models[0].provider).toBe('anthropic');
  });

  it('setModel posts the new model and updates state', async () => {
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.models.length).toBe(2));
    await result.current.setModel('openai', 'gpt-5');
    await waitFor(() => expect(result.current.activeModelId).toBe('openai/gpt-5'));
  });

  it('handles fetch errors by leaving models empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual([]);
  });
});

describe('modelKey', () => {
  it('encodes as provider/id', () => {
    expect(modelKey('opencode-go', 'glm-4.6')).toBe('opencode-go/glm-4.6');
  });
});

describe('parseModelKey', () => {
  it('parses a valid key', () => {
    expect(parseModelKey('opencode-go/glm-4.6')).toEqual({ provider: 'opencode-go', id: 'glm-4.6' });
  });
  it('returns undefined for an invalid key', () => {
    expect(parseModelKey('no-slash')).toBeUndefined();
    expect(parseModelKey('/leading-slash')).toBeUndefined();
    expect(parseModelKey('trailing-slash/')).toBeUndefined();
  });
});
