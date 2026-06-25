import { useCallback, useRef, useState } from 'react';
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

  // Synchronous guard so concurrent callers can't both read `false` while
  // the React state update is still in flight.
  const sendingRef = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const cancelActiveReader = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return;
    readerRef.current = null;
    reader.cancel().catch(() => undefined);
  }, []);

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
    if (!trimmed) return false;
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setError(null);

    const res = await apiFetch('/api/assistant/messages/stream', {
      method: 'POST',
      body: JSON.stringify({ content: trimmed }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      setError(await responseError(res));
      sendingRef.current = false;
      return false;
    }
    if (!res.body) {
      setError('Assistant response did not include a stream.');
      sendingRef.current = false;
      return false;
    }

    setIsRunning(true);
    const assistantDraft = localMessage('assistant', '');
    assistantDraft.isStreaming = true;
    setMessages((current) => [...current, localMessage('user', trimmed), assistantDraft]);

    const reader = res.body.getReader();
    readerRef.current = reader;
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
      // Reader cancelled by clear/abort — leave messages as-is, no error toast.
      if (readerRef.current !== reader) return false;
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (readerRef.current === reader) readerRef.current = null;
      sendingRef.current = false;
      setIsRunning(false);
    }
  }, []);

  const abort = useCallback(async () => {
    cancelActiveReader();
    await apiFetch('/api/assistant/abort', { method: 'POST' }).catch(() => undefined);
    sendingRef.current = false;
    setIsRunning(false);
  }, [cancelActiveReader]);

  const clear = useCallback(async (): Promise<boolean> => {
    setError(null);
    cancelActiveReader();
    await apiFetch('/api/assistant/abort', { method: 'POST' }).catch(() => undefined);
    const res = await apiFetch('/api/assistant/thread', { method: 'DELETE' });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    sendingRef.current = false;
    setIsRunning(false);
    setMessages([]);
    return true;
  }, [cancelActiveReader]);

  return { messages, isRunning, error, loadThread, send, abort, clear };
}
