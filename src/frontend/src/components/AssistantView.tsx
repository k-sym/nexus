import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowsClockwise, CloudArrowUp, PaperPlaneRight, Plus, Stop } from '@phosphor-icons/react';
import {
  AssistantMessage,
  AssistantSession,
  AssistantSessionStatus,
  useAssistantStream,
} from '../hooks/useAssistantStream';
import { confirmDialog } from '../lib/confirm';

export default function AssistantView() {
  const {
    sessions,
    selectedSession,
    selectedSessionId,
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
  } = useAssistantStream();
  const [input, setInput] = useState('');

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedSessionId) return;
    if (text === '/new') {
      const created = await createSession();
      if (created) setInput('');
      return;
    }
    if (text === '/clear') {
      if (!(await confirmDialog('Delete this Assistant session? This cannot be undone.'))) return;
      const cleared = await clear();
      if (cleared) setInput('');
      return;
    }
    if (isRunning) return;
    const sent = await send(text);
    if (sent) setInput('');
  }, [clear, createSession, input, isRunning, selectedSessionId, send]);

  const handleBackgroundRun = useCallback(async () => {
    const text = input.trim();
    if (!text || !selectedSessionId) return;
    const started = await startBackgroundRun(text);
    if (started) setInput('');
  }, [input, selectedSessionId, startBackgroundRun]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const trimmedInput = input.trim();
  const isCommand = trimmedInput === '/clear' || trimmedInput === '/new';

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-72 shrink-0 surface-glass border-r border-subtle flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-subtle flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Assistant</h1>
            <p className="text-xs text-faint">Hermes sessions</p>
          </div>
          <button
            type="button"
            onClick={() => void createSession()}
            className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
            title="New Assistant session"
            aria-label="New Session"
          >
            <Plus size={16} weight="bold" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-sm text-faint">No Assistant sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === selectedSessionId}
                onSelect={() => void loadSession(session.id)}
              />
            ))
          )}
        </div>
      </aside>

      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="surface-glass flex items-center justify-between px-6 py-3 border-b border-subtle shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{selectedSession?.title ?? 'Assistant'}</h2>
            <div className="flex items-center gap-2 text-xs text-faint">
              <span>{statusLabel(selectedSession?.status ?? latestRun?.status ?? 'idle')}</span>
              {latestRun?.remote_run_id && (
                <>
                  <span aria-hidden="true">/</span>
                  <span className="truncate">remote {latestRun.remote_run_id}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void sync()}
              className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
              title="Sync Assistant sessions"
              aria-label="Sync"
            >
              <ArrowsClockwise size={16} />
            </button>
            {(isRunning || latestRun?.status === 'running' || latestRun?.status === 'cancelling') && (
              <button
                type="button"
                onClick={() => void abort()}
                className="h-8 w-8 surface-elevated border border-subtle rounded-lg flex items-center justify-center text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors"
                title="Stop the current Assistant run"
                aria-label="Stop"
              >
                <Stop size={16} weight="fill" />
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <p className="text-faint text-sm">Send a message to start.</p>
          ) : (
            messages.map((message) => <AssistantBubble key={message.id} message={message} />)
          )}
        </div>

        {error && (
          <div className="px-4 py-2 border-t border-subtle text-xs text-red-300" role="alert">
            {error}
          </div>
        )}

        <div className="border-t border-subtle surface-glass p-3">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Assistant..."
              rows={2}
              disabled={!selectedSessionId}
              className="flex-1 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void handleBackgroundRun()}
              disabled={!input.trim() || !selectedSessionId}
              className="h-10 px-3 surface-elevated border border-subtle rounded-lg flex items-center gap-2 text-sm text-muted hover:text-[var(--text-primary)] hover:border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Start a detached Hermes run for this session"
            >
              <CloudArrowUp size={17} />
              Run in background
            </button>
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!trimmedInput || (isRunning && !isCommand) || !selectedSessionId}
              className="h-10 px-4 accent-button rounded-lg disabled:opacity-40 transition-colors flex items-center gap-2"
            >
              <PaperPlaneRight size={17} weight="fill" />
              Send
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SessionRow({ session, selected, onSelect }: { session: AssistantSession; selected: boolean; onSelect: () => void }) {
  const active = session.status === 'running' || session.latestRun?.status === 'running';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg px-3 py-2 border transition-colors ${
        selected
          ? 'surface-elevated border-strong text-primary'
          : 'border-transparent text-muted hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-[var(--border-strong)]'}`} aria-hidden="true" />
        <span className="text-sm font-medium truncate">{session.title}</span>
      </div>
      {session.updated_at && (
        <div className="text-[11px] text-faint mt-1 truncate">{relativeUpdatedAt(session.updated_at)}</div>
      )}
    </button>
  );
}

function AssistantBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-chat-role={isUser ? 'user' : 'assistant'}
        className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm ${
          isUser
            ? 'chat-request-bubble'
            : 'surface-glass border border-subtle text-primary'
        }`}
      >
        <p className="whitespace-pre-wrap">{message.content || (message.isStreaming ? 'Running...' : '')}</p>
      </div>
    </div>
  );
}

function statusLabel(status: AssistantSessionStatus): string {
  const normalized = String(status || 'idle');
  if (normalized === 'idle') return 'Idle';
  if (normalized === 'running') return 'Running';
  if (normalized === 'succeeded') return 'Completed';
  if (normalized === 'failed') return 'Failed';
  if (normalized === 'cancelled') return 'Cancelled';
  if (normalized === 'cancelling') return 'Cancelling';
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function relativeUpdatedAt(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}
