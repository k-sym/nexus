import { useCallback, useState } from 'react';
import { apiFetch } from '../api-base';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  isStreaming?: boolean;
}

function localMessage(role: AssistantMessage['role'], content: string): AssistantMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

async function responseError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as any).error || res.statusText || 'Assistant request failed.';
}

export function useAssistantStream() {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThread = useCallback(async () => {
    setError(null);
    const res = await apiFetch('/api/assistant/thread');
    if (!res.ok) {
      setError(await responseError(res));
      return;
    }
    const data = (await res.json()) as { messages?: AssistantMessage[] };
    setMessages(data.messages ?? []);
  }, []);

  const send = useCallback(async (content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || isRunning) return false;
    setError(null);

    const res = await apiFetch('/api/assistant/messages/stream', {
      method: 'POST',
      body: JSON.stringify({ content: trimmed }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    if (!res.body) {
      setError('Assistant response did not include a stream.');
      return false;
    }

    setIsRunning(true);
    const assistantDraft = localMessage('assistant', '');
    assistantDraft.isStreaming = true;
    setMessages((current) => [...current, localMessage('user', trimmed), assistantDraft]);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'text_delta') {
            setMessages((current) => current.map((message) =>
              message.id === assistantDraft.id
                ? { ...message, content: message.content + String(event.delta ?? '') }
                : message,
            ));
          } else if (event.type === 'error') {
            setError(String(event.error ?? 'Assistant request failed.'));
          }
        }
      }
      setMessages((current) => current.map((message) =>
        message.id === assistantDraft.id ? { ...message, isStreaming: false } : message,
      ));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsRunning(false);
    }
  }, [isRunning]);

  const abort = useCallback(async () => {
    await apiFetch('/api/assistant/abort', { method: 'POST' }).catch(() => undefined);
    setIsRunning(false);
  }, []);

  const clear = useCallback(async (): Promise<boolean> => {
    setError(null);
    const res = await apiFetch('/api/assistant/thread', { method: 'DELETE' });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    setMessages([]);
    return true;
  }, []);

  return { messages, isRunning, error, loadThread, send, abort, clear };
}
