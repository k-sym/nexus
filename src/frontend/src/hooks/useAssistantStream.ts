import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api-base';

export type AssistantSessionStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'cancelling' | string;

export interface AssistantRun {
  id: string;
  session_id?: string;
  remote_run_id?: string | null;
  remote_job_id?: string | null;
  kind?: 'chat' | 'overnight' | 'scheduled' | string;
  status: AssistantSessionStatus;
  input?: string;
  output?: string;
  error?: string | null;
  started_at?: string;
  completed_at?: string | null;
  updated_at?: string;
}

export interface AssistantSession {
  id: string;
  title: string;
  status: AssistantSessionStatus;
  remote_session_id?: string | null;
  remote_conversation_key?: string | null;
  last_run_id?: string | null;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  latestRun?: AssistantRun | null;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
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

function sessionStatusFromRun(session: AssistantSession, latestRun: AssistantRun | null): AssistantSessionStatus {
  if (latestRun?.status === 'running' || latestRun?.status === 'cancelling') return latestRun.status;
  return session.status ?? 'idle';
}

export function useAssistantStream() {
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [latestRun, setLatestRun] = useState<AssistantRun | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous guard so concurrent callers can't both read `false` while
  // the React state update is still in flight.
  const sendingRef = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const cancelActiveReader = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return;
    readerRef.current = null;
    reader.cancel().catch(() => undefined);
  }, []);

  const applySessionStatus = useCallback((session: AssistantSession, run: AssistantRun | null) => {
    setSessions((current) => current.map((item) =>
      item.id === session.id ? { ...item, ...session, status: sessionStatusFromRun(session, run), latestRun: run } : item,
    ));
  }, []);

  const loadSession = useCallback(async (sessionId: string): Promise<boolean> => {
    setError(null);
    const res = await apiFetch(`/api/assistant/sessions/${sessionId}`);
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    const data = (await res.json()) as {
      session: AssistantSession;
      messages?: AssistantMessage[];
      latestRun?: AssistantRun | null;
    };
    const run = data.latestRun ?? null;
    setSelectedSessionId(data.session.id);
    setMessages(data.messages ?? []);
    setLatestRun(run);
    setIsRunning(run?.status === 'running' || run?.status === 'cancelling');
    applySessionStatus(data.session, run);
    return true;
  }, [applySessionStatus]);

  const loadSessions = useCallback(async (): Promise<boolean> => {
    setError(null);
    const res = await apiFetch('/api/assistant/sessions');
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    const data = (await res.json()) as { sessions?: AssistantSession[] };
    const nextSessions = data.sessions ?? [];
    setSessions(nextSessions);

    const currentSelectedId = selectedSessionIdRef.current;
    const target = currentSelectedId && nextSessions.some((session) => session.id === currentSelectedId)
      ? currentSelectedId
      : nextSessions[0]?.id;

    if (target) {
      return loadSession(target);
    }

    setSelectedSessionId(null);
    setMessages([]);
    setLatestRun(null);
    setIsRunning(false);
    return true;
  }, [loadSession]);

  const createSession = useCallback(async (title = 'New Assistant Session'): Promise<boolean> => {
    setError(null);
    const res = await apiFetch('/api/assistant/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    const session = (await res.json()) as AssistantSession;
    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    return loadSession(session.id);
  }, [loadSession]);

  const send = useCallback(async (content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || !selectedSessionId) return false;
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setError(null);

    const res = await apiFetch(`/api/assistant/sessions/${selectedSessionId}/messages/stream`, {
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
    setLatestRun((run) => run ? { ...run, status: 'running' } : run);
    setSessions((current) => current.map((session) =>
      session.id === selectedSessionId ? { ...session, status: 'running' } : session,
    ));
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
          if (event.type === 'run_start') {
            setLatestRun({
              id: String(event.runId ?? ''),
              remote_run_id: event.remoteRunId ? String(event.remoteRunId) : null,
              status: 'running',
            });
          } else if (event.type === 'text_delta') {
            setMessages((current) => current.map((message) =>
              message.id === assistantDraft.id
                ? { ...message, content: message.content + String(event.delta ?? '') }
                : message,
            ));
          } else if (event.type === 'complete') {
            const status = String(event.status ?? 'succeeded');
            setLatestRun((run) => run ? { ...run, status } : { id: String(event.runId ?? ''), status });
            setSessions((current) => current.map((session) =>
              session.id === selectedSessionId ? { ...session, status: status === 'succeeded' ? 'idle' : status } : session,
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
      // Reader cancelled by abort or session switch; leave messages as-is.
      if (readerRef.current !== reader) return false;
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (readerRef.current === reader) readerRef.current = null;
      sendingRef.current = false;
      setIsRunning(false);
    }
  }, [selectedSessionId]);

  const startBackgroundRun = useCallback(async (content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || !selectedSessionId) return false;
    setError(null);
    const res = await apiFetch(`/api/assistant/sessions/${selectedSessionId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ content: trimmed }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    const data = (await res.json()) as { run?: AssistantRun };
    if (data.run) {
      setLatestRun(data.run);
      setSessions((current) => current.map((session) =>
        session.id === selectedSessionId ? { ...session, status: data.run?.status ?? 'running', latestRun: data.run } : session,
      ));
    }
    setMessages((current) => [...current, localMessage('user', trimmed)]);
    return true;
  }, [selectedSessionId]);

  const sync = useCallback(async (): Promise<boolean> => {
    setError(null);
    const res = await apiFetch('/api/assistant/sync', { method: 'POST' });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    if (selectedSessionId) {
      await loadSession(selectedSessionId);
    }
    await loadSessions();
    return true;
  }, [loadSession, loadSessions, selectedSessionId]);

  const abort = useCallback(async () => {
    cancelActiveReader();
    await apiFetch('/api/assistant/abort', { method: 'POST' }).catch(() => undefined);
    sendingRef.current = false;
    setIsRunning(false);
    setLatestRun((run) => run ? { ...run, status: 'cancelled' } : run);
    setSessions((current) => current.map((session) =>
      session.id === selectedSessionId ? { ...session, status: 'cancelled' } : session,
    ));
  }, [cancelActiveReader, selectedSessionId]);

  const clear = useCallback(async (): Promise<boolean> => {
    if (!selectedSessionId) return false;
    setError(null);
    cancelActiveReader();
    await apiFetch('/api/assistant/abort', { method: 'POST' }).catch(() => undefined);
    const res = await apiFetch(`/api/assistant/sessions/${selectedSessionId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    sendingRef.current = false;
    setIsRunning(false);
    setMessages([]);
    setLatestRun(null);
    setSessions((current) => current.filter((session) => session.id !== selectedSessionId));
    await loadSessions();
    return true;
  }, [cancelActiveReader, loadSessions, selectedSessionId]);

  return {
    sessions,
    selectedSessionId,
    selectedSession: sessions.find((session) => session.id === selectedSessionId) ?? null,
    messages,
    latestRun,
    isRunning,
    error,
    loadSessions,
    loadSession,
    createSession,
    send,
    startBackgroundRun,
    sync,
    abort,
    clear,
  };
}
