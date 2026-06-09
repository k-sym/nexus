import { useCallback, useEffect, useState } from 'react';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  configured?: boolean;
}

/** Encode a model as `provider/id` for use as a key. */
export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Decode a `provider/id` key. Returns undefined if not in the expected shape. */
export function parseModelKey(key: string): { provider: string; id: string } | undefined {
  const idx = key.indexOf('/');
  if (idx < 1 || idx >= key.length - 1) return undefined;
  return { provider: key.slice(0, idx), id: key.slice(idx + 1) };
}

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/models');
        if (!res.ok) throw new Error(`models: ${res.status}`);
        const data = (await res.json()) as { models: ModelInfo[] };
        if (cancelled) return;
        setModels(data.models || []);
      } catch (err) {
        console.error('useModels: failed to load models', err);
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setModel = useCallback(async (provider: string, id: string) => {
    const key = modelKey(provider, id);
    setActiveModelId(key);
    try {
      await fetch('/api/models/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: id }),
      });
    } catch (err) {
      console.error('useModels: failed to set active model', err);
    }
  }, []);

  return { models, activeModelId, loading, setModel };
}
