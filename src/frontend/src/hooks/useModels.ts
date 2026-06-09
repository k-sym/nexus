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
  // Store active model per thread: threadId -> modelKey
  const [activeModels, setActiveModels] = useState<Record<string, string>>({});
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
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

  const setThread = useCallback((threadId: string | null) => {
    setCurrentThreadId(threadId);
  }, []);

  const setModel = useCallback(async (provider: string, id: string) => {
    if (!currentThreadId) return;
    
    // Allow clearing the model by passing empty strings
    if (!provider || !id) {
      setActiveModels(prev => {
        const next = { ...prev };
        delete next[currentThreadId];
        return next;
      });
      return;
    }
    
    const key = modelKey(provider, id);
    setActiveModels(prev => ({
      ...prev,
      [currentThreadId]: key,
    }));
    
    try {
      await fetch('/api/models/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: id }),
      });
    } catch (err) {
      console.error('useModels: failed to set active model', err);
    }
  }, [currentThreadId]);

  const activeModelId = currentThreadId ? activeModels[currentThreadId] : undefined;

  return { models, activeModelId, loading, setModel, setThread };
}
