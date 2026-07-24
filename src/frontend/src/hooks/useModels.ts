import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api-base';
import type { ThinkingLevel } from '../lib/thinking';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  configured?: boolean;
  thinkingLevels?: ThinkingLevel[];
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

/** Total attempts (1 initial + retries) for the cold-start model load. */
const MODEL_LOAD_ATTEMPTS = 4;
/** Base backoff between retries; multiplied by the attempt number. */
const MODEL_LOAD_BACKOFF_MS = 250;

/** Resolve after `ms`. Callers re-check their own cancellation after awaiting. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [allModels, setAllModels] = useState<ModelInfo[]>([]);
  const [enabledModelKeys, setEnabledModelKeys] = useState<string[]>([]);
  const [customized, setCustomized] = useState(false);
  // Store active model per thread: threadId -> modelKey
  const [activeModels, setActiveModels] = useState<Record<string, string>>({});
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadModels = useCallback(async (cancelled?: () => boolean) => {
    const clearModels = () => {
      setModels([]);
      setAllModels([]);
      setEnabledModelKeys([]);
      setCustomized(false);
    };
    // The packaged (WebKit) app can drop the very first requests at cold
    // start: `fetch` rejects with a TypeError ("Load failed") before it ever
    // reaches the backend. That leaves the model dropdown empty until the
    // panel remounts. Retry transport rejections with a short backoff so a
    // cold-start miss recovers on its own. A *response* (even non-ok) means
    // the backend answered — that's a real error, so we don't retry it.
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await apiFetch('/api/models');
      } catch (err) {
        if (cancelled?.()) return;
        if (attempt < MODEL_LOAD_ATTEMPTS) {
          await delay(MODEL_LOAD_BACKOFF_MS * attempt);
          if (cancelled?.()) return;
          continue;
        }
        console.error('useModels: models fetch failed after retries', err);
        if (!cancelled?.()) { clearModels(); setLoading(false); }
        return;
      }
      try {
        if (!res.ok) throw new Error(`models: ${res.status}`);
        const data = (await res.json()) as {
          models: ModelInfo[];
          allModels?: ModelInfo[];
          enabledModelKeys?: string[];
          customized?: boolean;
        };
        if (cancelled?.()) return;
        setModels(data.models || []);
        setAllModels(data.allModels || data.models || []);
        setEnabledModelKeys(data.enabledModelKeys || []);
        setCustomized(data.customized === true);
      } catch (err) {
        console.error('useModels: failed to load models', err);
        if (!cancelled?.()) clearModels();
      } finally {
        if (!cancelled?.()) setLoading(false);
      }
      return;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadModels(() => cancelled);
    function refreshModels() {
      void loadModels();
    }
    window.addEventListener('nexus:models-refresh', refreshModels);
    return () => {
      cancelled = true;
      window.removeEventListener('nexus:models-refresh', refreshModels);
    };
  }, [loadModels]);

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
      await apiFetch('/api/models/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: id }),
      });
    } catch (err) {
      console.error('useModels: failed to set active model', err);
    }
  }, [currentThreadId]);

  const saveCuration = useCallback(async (keys: string[]) => {
    const res = await apiFetch('/api/models/curation', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledModelKeys: keys }),
    });
    if (!res.ok) throw new Error(`models curation: ${res.status}`);
    const data = (await res.json()) as {
      models: ModelInfo[];
      allModels: ModelInfo[];
      enabledModelKeys: string[];
      customized: boolean;
    };
    setModels(data.models || []);
    setAllModels(data.allModels || []);
    setEnabledModelKeys(data.enabledModelKeys || []);
    setCustomized(data.customized === true);
  }, []);

  const activeModelId = currentThreadId ? activeModels[currentThreadId] : undefined;

  return { models, allModels, enabledModelKeys, customized, activeModelId, loading, setModel, setThread, saveCuration };
}
