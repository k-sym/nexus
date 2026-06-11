/**
 * ChatPanel — the chat pane.
 *
 * Subscribes to the pi runtime's event stream for the active thread via
 * usePiStream. The X-Confirm-Cancel conflict path (different thread in
 * the same project is mid-run) surfaces as a confirm dialog.
 *
 * The previous file uploaded attachments, exported to JSONL, and used
 * a custom "Claude session resume" chip. All of that is gone:
 *   - Attachments: deferred to a follow-up (the route is still there at
 *     POST /api/threads/:id/upload but the UI doesn't expose it yet)
 *   - Export: pi sessions are already on disk in pi's tree format;
 *     the user can read them from ~/.nexus/sessions/{cwd-slug}/*.jsonl
 *   - Session resume: pi owns sessions natively; no terminal hand-off
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stop } from '@phosphor-icons/react';
import { usePiStream, ChatBusyError, type StreamMessage } from '../hooks/usePiStream';
import { useModels } from '../hooks/useModels';
import { apiFetch } from '../api-base';
import { ModelSelector } from './ModelSelector';
import { ToolCallTimeline } from './ToolCallTimeline';
import { ThinkingBlock } from './ThinkingBlock';

interface ChatPanelProps {
  projectId: string;
  threadId: string | null;
  /** Called when the user confirms cancelling a busy thread in the same project. */
  onBusyConflict: (activeThreadId: string, activeTitle: string) => void;
  /** Called after a turn completes so the sidebar (title etc.) can refresh. */
  onThreadsChanged?: () => void;
  /** Reports whether this session is actively streaming/thinking/tooling. */
  onSessionActivityChange?: (threadId: string, active: boolean) => void;
}

export default function ChatPanel({ projectId, threadId, onBusyConflict, onThreadsChanged, onSessionActivityChange }: ChatPanelProps) {
  const { models, activeModelId, setModel, setThread } = useModels();
  const { state, startStream, abortStream, dispatch, setActiveThread } = usePiStream();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<StreamMessage[]>([]);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ activeThreadId: string; activeTitle: string; pendingText: string } | null>(null);
  const [modelBusy, setModelBusy] = useState<{ threadId: string; title: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Update the active thread in usePiStream to filter events correctly
  useEffect(() => {
    setActiveThread(threadId);
  }, [threadId, setActiveThread]);

  // Tell useModels which thread is active (for per-thread model tracking)
  useEffect(() => {
    setThread(threadId);
  }, [threadId, setThread]);

  useEffect(() => {
    if (!threadId || !onSessionActivityChange) return;
    onSessionActivityChange(threadId, state.isRunning);
    return () => onSessionActivityChange(threadId, false);
  }, [threadId, state.isRunning, onSessionActivityChange]);

  // Reset stream state, abort any active stream, and clear input when switching threads.
  useEffect(() => {
    abortStream();
    dispatch({ type: 'RESET' });
    setError(null);
    setPendingConfirm(null);
    setInput('');
  }, [threadId, dispatch, abortStream]);

  // Check if the selected model is busy in another thread (poll every 2 seconds)
  useEffect(() => {
    if (!projectId || !activeModelId) {
      setModelBusy(null);
      return;
    }

    let cancelled = false;
    const checkStatus = async () => {
      try {
        const res = await apiFetch(`/api/projects/${projectId}/model-status?modelKey=${encodeURIComponent(activeModelId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          if (data.busy && data.activeThreadId !== threadId) {
            setModelBusy({ threadId: data.activeThreadId, title: data.activeTitle });
          } else {
            setModelBusy(null);
          }
        }
      } catch (err) {
        console.error('Failed to check model status:', err);
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId, activeModelId, threadId]);

  // Helper to fetch thread messages (without setting model)
  const fetchThreadMessages = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/threads/${id}`);
      if (!res.ok) throw new Error(`GET /api/threads/${id} ${res.status}`);
      const data = (await res.json()) as { messages: any[] };
      return (data.messages ?? []).map((m: any) => ({
        ...m,
        toolCalls: m.tool_calls ?? m.toolCalls ?? undefined,
      })) as StreamMessage[];
    } catch (err) {
      console.error('Failed to load thread messages', err);
      return [];
    }
  }, []);

  // Load persisted messages and restore thread's model when switching threads
  useEffect(() => {
    if (!threadId) {
      setLoadedMessages([]);
      setModel('', '');
      return;
    }
    
    // Clear messages and model immediately when switching threads
    setLoadedMessages([]);
    setModel('', '');
    
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/threads/${threadId}`);
        if (!res.ok) throw new Error(`GET /api/threads/${threadId} ${res.status}`);
        const data = (await res.json()) as { messages: any[]; thread?: any };
        
        // Restore the thread's saved model if it has one
        if (!cancelled && data.thread?.last_model_key) {
          const idx = data.thread.last_model_key.indexOf('/');
          if (idx > 0) {
            const provider = data.thread.last_model_key.slice(0, idx);
            const modelId = data.thread.last_model_key.slice(idx + 1);
            setModel(provider, modelId);
          }
        }
        
        if (!cancelled) {
          const msgs = (data.messages ?? []).map((m: any) => ({
            ...m,
            toolCalls: m.tool_calls ?? m.toolCalls ?? undefined,
          })) as StreamMessage[];
          setLoadedMessages(msgs);
        }
      } catch (err) {
        console.error('Failed to load thread messages', err);
        if (!cancelled) setLoadedMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, setModel]);

  // Ctrl+O toggles the details-expanded view (tool timeline, full thinking).
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        setDetailsExpanded((v) => !v);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-scroll on any visible-message change. (jsdom doesn't implement
  // scrollIntoView; the optional-chained guard keeps tests green.)
  useEffect(() => {
    const el = messagesEndRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [loadedMessages, state.messages, state.streamingMessage]);

  const submit = useCallback(
    async (text: string, opts: { confirmCancel?: boolean } = {}) => {
      if (!threadId) return;
      setError(null);
      try {
        await startStream(threadId, text, { ...opts, modelKey: activeModelId });
        onThreadsChanged?.();
        const msgs = await fetchThreadMessages(threadId);
        if (msgs.length > 0) {
          dispatch({ type: 'RESET' });
          setLoadedMessages(msgs);
        }
      } catch (err) {
        if (err instanceof ChatBusyError) {
          setPendingConfirm({
            activeThreadId: err.activeThreadId,
            activeTitle: err.activeTitle,
            pendingText: text,
          });
          onBusyConflict(err.activeThreadId, err.activeTitle);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [threadId, startStream, onBusyConflict, onThreadsChanged, activeModelId, fetchThreadMessages, dispatch],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !threadId) return;
    setInput('');
    void submit(text);
  }, [input, threadId, submit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAbort = useCallback(async () => {
    if (!threadId) return;
    try {
      await apiFetch(`/api/threads/${threadId}/abort`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    await abortStream();
  }, [threadId, abortStream]);

  const confirmCancelOther = useCallback(async () => {
    if (!pendingConfirm) return;
    const text = pendingConfirm.pendingText;
    setPendingConfirm(null);
    setInput('');
    try {
      await submit(text, { confirmCancel: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pendingConfirm, submit]);

  if (!threadId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-faint text-sm">Select a session, or use “+ New Session” in the tree to start one.</p>
        </div>
      </div>
    );
  }

  const visible = loadedMessages.concat(state.messages);
  const streaming = state.streamingMessage;
  const isRunning = state.isRunning;
  const isEmpty = visible.length === 0 && !streaming;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <header className="px-4 py-2 border-b border-subtle surface-glass flex items-center gap-3">
        <ModelSelector
          models={models}
          currentModelId={activeModelId}
          onSelect={(p, id) => setModel(p, id)}
        />
        {activeModelId && (
          <span className="text-[10px] text-faint truncate" data-testid="active-model-label">
            {activeModelId}
          </span>
        )}
      </header>

      {modelBusy && (
        <div className="px-4 py-2 border-b border-amber-800/50 bg-amber-950/30 text-xs text-amber-200">
          <span className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span>
              This model is currently streaming in "{modelBusy.title}". Wait for it to finish or choose a different model.
            </span>
          </span>
        </div>
      )}

      {pendingConfirm && (
        <div className="px-4 py-2 border-b border-amber-800/50 bg-amber-950/30 text-xs text-amber-200 flex items-center gap-3">
          <span className="flex-1 min-w-0 truncate">
            “{pendingConfirm.activeTitle}” is still running. Start a new session anyway (will cancel it)?
          </span>
          <button
            onClick={() => setPendingConfirm(null)}
            className="px-2 py-0.5 rounded border border-subtle text-muted hover:text-white"
          >
            Wait
          </button>
          <button
            onClick={confirmCancelOther}
            className="px-2 py-0.5 rounded border border-amber-700 bg-amber-800/50 text-amber-100 hover:bg-amber-700/50"
          >
            Start (cancel)
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="chat-messages">
        {isEmpty ? (
          <p className="text-faint text-sm">Send a message to start.</p>
        ) : (
          visible.map((m) => <MessageBubble key={m.id} msg={m} detailsExpanded={detailsExpanded} />)
        )}
        {streaming && <MessageBubble msg={streaming} detailsExpanded={detailsExpanded} />}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="px-4 py-2 border-t border-subtle text-xs text-red-300" role="alert">
          {error}
        </div>
      )}

      <div className="border-t border-subtle surface-glass p-3 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={2}
          data-testid="chat-input"
          className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong"
        />
        {isRunning ? (
          <button
            type="button"
            onClick={handleAbort}
            data-testid="abort-button"
            className="px-3 py-2 surface-elevated text-muted rounded-lg hover:text-[var(--text-primary)] transition-colors"
            title="Stop the current generation"
          >
            <Stop className="w-5 h-5" weight="fill" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            data-testid="send-button"
            disabled={!input.trim()}
            className="px-4 py-2 accent-button rounded-lg disabled:opacity-40 transition-colors"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg, detailsExpanded }: { msg: StreamMessage; detailsExpanded: boolean }) {
  const isUser = msg.role === 'user';
  const isTool = msg.role === 'toolResult';
  const isThinking = msg.isStreaming === true && !msg.content && !!msg.thinking;
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-chat-role={isUser ? 'user' : isTool ? 'tool' : 'assistant'}
        className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm ${
          isUser
            ? 'chat-request-bubble'
            : isTool
              ? 'surface-panel border border-subtle text-muted text-xs'
              : 'surface-glass border border-subtle text-primary'
        }`}
      >
        {!isUser && msg.thinking && (
          <ThinkingBlock
            thinking={msg.thinking}
            isThinking={isThinking}
            expanded={detailsExpanded}
          />
        )}
        {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mb-2">
            <ToolCallTimeline toolCalls={msg.toolCalls as any} detailsExpanded={detailsExpanded} />
          </div>
        )}
        {isTool ? (
          <span>
            <code className="text-faint">{msg.toolName}</code>
            {msg.isError ? ' (error)' : ''}
          </span>
        ) : (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        )}
      </div>
    </div>
  );
}
