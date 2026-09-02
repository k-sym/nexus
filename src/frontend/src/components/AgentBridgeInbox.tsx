import { useCallback, useEffect, useState } from 'react';
import { api, type AgentBridgeMessage, type AgentBridgeStatus } from '../api';

export function AgentBridgeInbox() {
  const [status, setStatus] = useState<AgentBridgeStatus | null>(null);
  const [messages, setMessages] = useState<AgentBridgeMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, inbox] = await Promise.all([
        api.agentBridge.status(),
        api.agentBridge.messages(),
      ]);
      setStatus(nextStatus);
      setMessages(inbox.messages);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent Bridge status is unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    setError(null);
    try {
      await api.agentBridge[decision](id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${decision} the message.`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="border-t border-subtle pt-3 space-y-3" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-muted">Inbox</div>
          {status && (
            <p className="text-[10px] text-faint mt-0.5">
              Runtime: <span className={status.state === 'connected' ? 'text-green-400' : status.state === 'error' ? 'text-red-400' : 'text-muted'}>{status.state}</span>
              {' · '}{status.subject}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="min-h-11 px-3 rounded-sm surface-elevated text-xs text-muted hover:text-primary border border-subtle disabled:opacity-40 transition-colors"
        >
          {loading ? 'Refreshing…' : 'Refresh inbox'}
        </button>
      </div>

      {status?.error && <p className="text-xs text-red-400">{status.error}</p>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {!loading && messages.length === 0 && (
        <p className="text-xs text-faint">No bridge messages yet.</p>
      )}
      {messages.map((message) => {
        const sender = message.sender_display_name || message.sender_id;
        return (
          <article key={message.id} className="surface-panel border border-subtle rounded-sm p-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-primary font-medium break-words">{sender}</div>
                <div className="text-[10px] text-faint break-all">{message.sender_id} · {new Date(message.received_at).toLocaleString()}</div>
              </div>
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted">{statusLabel(message.status)}</span>
            </div>
            <p className="text-xs text-primary whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
            {message.rejection_reason && <p className="text-[10px] text-red-400">{message.rejection_reason}</p>}
            {message.status === 'pending_approval' && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void decide(message.id, 'approve')}
                  disabled={busyId !== null}
                  className="min-h-11 px-3 rounded-sm accent-button text-xs disabled:opacity-40 transition-colors"
                >
                  {busyId === message.id ? 'Starting…' : 'Run in target thread'}
                </button>
                <button
                  type="button"
                  onClick={() => void decide(message.id, 'reject')}
                  disabled={busyId !== null}
                  className="min-h-11 px-3 rounded-sm surface-elevated text-xs text-muted hover:text-primary border border-subtle disabled:opacity-40 transition-colors"
                >
                  Reject
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function statusLabel(status: AgentBridgeMessage['status']): string {
  return status.replaceAll('_', ' ');
}
