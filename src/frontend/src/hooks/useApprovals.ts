/**
 * Live tool-approval queue.
 *
 * Subscribes to `/api/approvals/stream` (NDJSON, same idiom as the chat stream
 * — `EventSource` can't carry the bearer a token-gated backend needs) and keeps
 * the pending set in sync. Holding this stream open is also what tells the
 * backend a human is present, which buys parked gates the longer attended
 * timeout instead of the 5-minute unattended one.
 *
 * Phase 2 of #266.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api-base';

export type ToolCategory =
  | 'interactive' | 'read' | 'write' | 'exec' | 'services' | 'network' | 'unknown';

export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  input: unknown;
  cwd: string;
  requestedAt: number;
}

type StreamEvent =
  | { kind: 'snapshot'; approvals: PendingApproval[] }
  | { kind: 'pending'; approval: PendingApproval }
  | { kind: 'resolved'; threadId: string; toolCallId: string };

/** How long to wait before reconnecting a dropped stream. */
const RECONNECT_MS = 3_000;

export interface UseApprovalsResult {
  approvals: PendingApproval[];
  /** True while the stream is up. When false the backend has no reason to
   *  believe anyone is watching, and gates fall back to the short timeout. */
  connected: boolean;
  decide: (toolCallId: string, action: 'allow' | 'deny', reason?: string) => Promise<void>;
}

export function useApprovals(): UseApprovalsResult {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [connected, setConnected] = useState(false);
  // Guards the reconnect loop against a StrictMode double-mount and against
  // scheduling a retry after unmount.
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (stoppedRef.current) return;
      controller = new AbortController();
      try {
        const res = await apiFetch('/api/approvals/stream', { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        setConnected(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue; // heartbeat
            let event: StreamEvent;
            try {
              event = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            applyEvent(event);
          }
        }
      } catch {
        /* dropped or aborted — handled by the reconnect below */
      }
      if (stoppedRef.current) return;
      setConnected(false);
      // Don't keep stale gates on screen while disconnected: we can no longer
      // hear about them resolving, so anything shown would be a guess. The
      // reconnect's snapshot is the truth.
      setApprovals([]);
      retry = setTimeout(connect, RECONNECT_MS);
    };

    const applyEvent = (event: StreamEvent): void => {
      if (event.kind === 'snapshot') {
        setApprovals(event.approvals);
        return;
      }
      if (event.kind === 'pending') {
        setApprovals((prev) =>
          // The stream subscribes before it snapshots, so the same gate can
          // arrive twice. Keyed by toolCallId, a duplicate is a no-op.
          prev.some((a) => a.toolCallId === event.approval.toolCallId) ? prev : [...prev, event.approval],
        );
        return;
      }
      setApprovals((prev) => prev.filter((a) => a.toolCallId !== event.toolCallId));
    };

    void connect();
    return () => {
      stoppedRef.current = true;
      if (retry) clearTimeout(retry);
      controller?.abort();
      setConnected(false);
    };
  }, []);

  const decide = useCallback(async (toolCallId: string, action: 'allow' | 'deny', reason?: string) => {
    // Drop it locally first: the round trip is short but a second click on a
    // gate that is already decided is worse than a momentary optimistic hide.
    // The stream's `resolved` confirms, and a 404 means someone else answered
    // it — in both cases removed is the correct end state.
    setApprovals((prev) => prev.filter((a) => a.toolCallId !== toolCallId));
    try {
      await apiFetch(`/api/approvals/${encodeURIComponent(toolCallId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
      });
    } catch {
      /* the gate is gone from our view either way; the backend defaults to deny */
    }
  }, []);

  return { approvals, connected, decide };
}
