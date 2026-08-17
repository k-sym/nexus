/**
 * useIdeaThread — lean chat hook for one idea's dialogue (#352).
 *
 * An idea's dialogue IS an ordinary assistant session, so this speaks the same
 * per-session endpoints as useAssistantStream (GET /api/assistant/sessions/:id,
 * POST .../messages/stream NDJSON) and folds stream events through the shared
 * agent-run reducers. It deliberately does NOT reuse useAssistantStream
 * wholesale: that hook manages the Assistant rail's whole session list, while
 * an idea thread is pinned to a single known session id. Unlike the rail's
 * composer, `send` accepts a modelKey (the backend accepts it; the Research
 * action needs it).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api-base';
import { agentRunReducer, type AgentRunView } from '../chat/agent-run-state';
import { agentRunActionsFor } from '../chat/agent-run-events';
import type { AssistantAttachment, AssistantMessage, AssistantRun } from './useAssistantStream';
import { nextUserOrdinal, reattachAttachments, recordAttachments } from './assistantAttachmentCache';

export interface IdeaSendOptions {
  /** 'partner/<id>'; omitted → the session's/adapter's default. */
  modelKey?: string;
  attachments?: AssistantAttachment[];
  /** Called with the failure message (e.g. the backend's target-repo gate 400). */
  onError?: (message: string) => void;
}

function toAssistantMessage(raw: any): AssistantMessage {
  return {
    ...raw,
    toolCalls: raw.tool_calls ?? raw.toolCalls ?? undefined,
  } as AssistantMessage;
}

function localMessage(role: AssistantMessage['role'], content: string, attachments?: AssistantAttachment[]): AssistantMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    created_at: new Date().toISOString(),
  };
}

async function responseError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as any).error || res.statusText || 'Assistant request failed.';
}

function isActiveRunStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'cancelling';
}

export function useIdeaThread(sessionId: string | null) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [latestRun, setLatestRun] = useState<AssistantRun | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous guard so concurrent callers can't both read `false` while the
  // React state update is still in flight (mirrors useAssistantStream).
  const sendingRef = useRef(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  // Mirrors `messages` so send can read the current user-row count
  // synchronously (to key the sent-attachment cache) without a stale closure.
  const messagesRef = useRef<AssistantMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const cancelActiveReader = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return;
    readerRef.current = null;
    reader.cancel().catch(() => undefined);
  }, []);

  const reload = useCallback(async (): Promise<boolean> => {
    const id = sessionIdRef.current;
    if (!id) return false;
    const res = await apiFetch(`/api/assistant/sessions/${id}`);
    if (sessionIdRef.current !== id) return false; // switched away mid-flight
    if (!res.ok) {
      setError(await responseError(res));
      return false;
    }
    const data = (await res.json()) as {
      messages?: AssistantMessage[];
      latestRun?: AssistantRun | null;
    };
    if (sessionIdRef.current !== id) return false;
    const run = data.latestRun ?? null;
    // The server transcript is text-only; re-attach cached sent thumbnails.
    setMessages(reattachAttachments((data.messages ?? []).map(toAssistantMessage), id));
    setLatestRun(run);
    return true;
  }, []);

  // Load (and reset) whenever the idea's session changes.
  useEffect(() => {
    cancelActiveReader();
    sendingRef.current = false;
    setMessages([]);
    setLatestRun(null);
    setIsStreaming(false);
    setError(null);
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        await reload();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, reload, cancelActiveReader]);

  const send = useCallback(async (content: string, opts: IdeaSendOptions = {}): Promise<boolean> => {
    const trimmed = content.trim();
    const id = sessionIdRef.current;
    const attachments = opts.attachments ?? [];
    if ((!trimmed && attachments.length === 0) || !id || sendingRef.current) return false;
    sendingRef.current = true;
    setError(null);

    const fail = (message: string) => {
      setError(message);
      opts.onError?.(message);
    };

    // Cache the sent thumbnails at this turn's ordinal so they survive a
    // reload (the server transcript comes back text-only).
    recordAttachments(id, nextUserOrdinal(messagesRef.current), attachments);
    // Render the user's message + a streaming draft BEFORE the request, so a
    // transport failure can never leave the UI blank.
    const assistantDraft = localMessage('assistant', '');
    assistantDraft.isStreaming = true;
    setMessages((current) => [...current, localMessage('user', trimmed, attachments), assistantDraft]);
    setIsStreaming(true);
    setLatestRun((run) => run ? { ...run, status: 'running' } : run);

    // Drop the empty placeholder on a pre-stream failure; keep it and stop the
    // spinner once content has arrived.
    const dropOrFinalizeDraft = () => setMessages((current) => {
      const draft = current.find((message) => message.id === assistantDraft.id);
      if (draft && !draft.content && !draft.thinking && !draft.run) {
        return current.filter((message) => message.id !== assistantDraft.id);
      }
      return current.map((message) =>
        message.id === assistantDraft.id ? { ...message, isStreaming: false } : message,
      );
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let remoteStillRunning = false;
    let runView: AgentRunView | null = null;
    try {
      const res = await apiFetch(`/api/assistant/sessions/${id}/messages/stream`, {
        method: 'POST',
        body: JSON.stringify({
          content: trimmed,
          ...(opts.modelKey ? { modelKey: opts.modelKey } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        // e.g. the idea-session attachment gate: 400 "Set a valid target repo…"
        fail(await responseError(res));
        dropOrFinalizeDraft();
        return false;
      }
      if (!res.body) {
        fail('Assistant response did not include a stream.');
        dropOrFinalizeDraft();
        return false;
      }

      reader = res.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          for (const action of agentRunActionsFor(event, Date.now())) {
            runView = agentRunReducer(runView, action);
          }
          if (event.kind === 'run_start') {
            setLatestRun({
              id: String(event.run?.runId ?? ''),
              remote_run_id: event.run?.runId ? String(event.run.runId) : null,
              status: 'running',
            });
            setMessages((current) => current.map((message) =>
              message.id === assistantDraft.id ? { ...message, run: runView ?? undefined } : message,
            ));
          } else if (event.type === 'message_update') {
            const ame = event.assistantMessageEvent;
            if (ame?.type === 'text_delta') {
              setMessages((current) => current.map((message) =>
                message.id === assistantDraft.id
                  ? { ...message, content: message.content + String(ame.delta ?? ''), run: runView ?? message.run }
                  : message,
              ));
            } else if (ame?.type === 'thinking_delta') {
              setMessages((current) => current.map((message) =>
                message.id === assistantDraft.id
                  ? { ...message, thinking: (message.thinking ?? '') + String(ame.delta ?? ''), run: runView ?? message.run }
                  : message,
              ));
            }
          } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'tool_execution_update') {
            setMessages((current) => current.map((message) =>
              message.id === assistantDraft.id ? { ...message, run: runView ?? message.run } : message,
            ));
          } else if (event.kind === 'run_end') {
            const status = String(event.run?.status ?? 'completed');
            remoteStillRunning = false;
            setLatestRun((run) => run ? { ...run, status } : { id: String(event.run?.runId ?? ''), status });
            setMessages((current) => current.map((message) =>
              message.id === assistantDraft.id ? { ...message, run: runView ?? message.run, isStreaming: false } : message,
            ));
          } else if (event.type === 'error') {
            setError(String(event.error ?? 'Assistant request failed.'));
          }

          // Back-compat: honor the legacy flat events if the backend degraded.
          if (event.type === 'text_delta') {
            setMessages((current) => current.map((message) =>
              message.id === assistantDraft.id
                ? { ...message, content: message.content + String(event.delta ?? '') }
                : message,
            ));
          } else if (event.type === 'complete') {
            const status = String(event.status ?? 'succeeded');
            remoteStillRunning = isActiveRunStatus(status);
            setLatestRun((run) => run ? { ...run, status } : { id: String(event.runId ?? ''), status });
          }
        }
      }
      setMessages((current) => current.map((message) =>
        message.id === assistantDraft.id ? { ...message, isStreaming: remoteStillRunning } : message,
      ));
      return true;
    } catch (err) {
      // Reader cancelled by abort or session switch: leave messages as-is.
      if (reader && readerRef.current !== reader) return false;
      fail(err instanceof Error ? err.message : String(err));
      dropOrFinalizeDraft();
      return false;
    } finally {
      if (reader && readerRef.current === reader) readerRef.current = null;
      sendingRef.current = false;
      setIsStreaming(remoteStillRunning);
    }
  }, []);

  const abort = useCallback(async () => {
    cancelActiveReader();
    await apiFetch('/api/assistant/abort', { method: 'POST' }).catch(() => undefined);
    sendingRef.current = false;
    setIsStreaming(false);
    setLatestRun((run) => run ? { ...run, status: 'cancelled' } : run);
  }, [cancelActiveReader]);

  const isRunning = isStreaming || isActiveRunStatus(latestRun?.status);

  // A background run (e.g. a research turn that outlived the stream) keeps
  // going server-side; poll the session until it settles.
  useEffect(() => {
    if (!sessionId || isStreaming || !isActiveRunStatus(latestRun?.status)) return undefined;
    const timer = window.setInterval(() => {
      if (!sendingRef.current) void reload();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [sessionId, isStreaming, latestRun?.status, reload]);

  return { messages, latestRun, isRunning, loading, error, send, abort, reload };
}
