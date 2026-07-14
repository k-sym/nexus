/**
 * Tool-permission "Supervise" gate.
 *
 * When a chat session is supervised, each of its tool calls is intercepted
 * before it executes (via the agent SDK's `beforeToolCall` → extension
 * `tool_call` hook) and parked here as a pending approval. The glasses cockpit
 * gateway surfaces it as an `Approval{kind:'approval'}`; the user taps Allow or
 * Deny on the G2, which resolves the parked promise:
 *
 *   - Allow → `{ block: false }` — the tool proceeds.
 *   - Deny  → `{ block: true, reason }` — the SDK emits an error tool result
 *     carrying `reason` instead of running the tool.
 *
 * This mirrors `QuestionBroker` (see ./questions.ts) beat-for-beat — same
 * register/decide/remove/subscribe shape, a single removal choke-point so every
 * registered gate emits exactly one `pending` then one `resolved`, and try/catch
 * around subscriber notification so a misbehaving listener can never wedge tool
 * resolution. The one addition is a timeout: an unanswered gate (glasses off,
 * user away) resolves as a default-DENY after `timeoutMs`, so a supervised
 * session never executes an unreviewed tool and never wedges forever.
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** The value returned to the SDK's `beforeToolCall`. `block:false` lets the
 *  tool run; `block:true` skips it and surfaces `reason` as the tool result. */
export interface ApprovalDecision {
  block: boolean;
  reason?: string;
}

/** Read-only view of a pending tool-gate, for enumerating across threads
 *  (the glasses cockpit gateway). Carries the tool name / input / cwd so the
 *  gateway can render the approval card without a second lookup. */
export interface PendingApprovalView {
  threadId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  cwd: string;
  requestedAt: number;
}

/** Broker lifecycle events for push-based consumers (the gateway SSE stream).
 *  `pending` fires the instant a gate registers; `resolved` fires when it leaves
 *  the pending set for any reason (allow, deny, cancel, thread dropped, abort,
 *  or timeout). Every registered gate emits exactly one `pending` then one
 *  `resolved`. */
export type ApprovalBrokerEvent =
  | { type: 'pending'; view: PendingApprovalView }
  | { type: 'resolved'; threadId: string; toolCallId: string };

export type ApprovalBrokerListener = (event: ApprovalBrokerEvent) => void;

export type ApprovalDecisionResponse =
  | { ok: true }
  | { ok: false; status: 404; error: string };

/** Default time a tool-gate waits for Allow/Deny before defaulting to DENY. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  threadId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  cwd: string;
  requestedAt: number;
  resolve: (decision: ApprovalDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<ApprovalBrokerListener>();

  /** Subscribe to pending/resolved events. Returns an unsubscribe fn. Used by
   *  the gateway to push SSE the moment a tool needs approval, rather than
   *  poll-diffing the pending set. */
  subscribe(listener: ApprovalBrokerListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Park a tool call as a pending approval and return a promise the interception
   * awaits. Resolves to `{block:false}` on allow, `{block:true, reason}` on deny,
   * cancel, thread-drop, abort, or timeout (all default to DENY so nothing runs
   * unreviewed).
   */
  register(
    threadId: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    cwd: string,
    signal?: AbortSignal,
    timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
  ): Promise<ApprovalDecision> {
    const key = this.key(threadId, toolCallId);
    if (this.pending.has(key)) return Promise.reject(new Error(`Approval already pending: ${toolCallId}`));

    return new Promise<ApprovalDecision>((resolve) => {
      const entry: PendingApproval = {
        threadId, toolCallId, toolName, input, cwd,
        requestedAt: Date.now(), resolve, signal,
      };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          this.denyEntry(key, `Approval timed out after ${Math.round(timeoutMs / 1000)}s — auto-denied`);
        }, timeoutMs);
        // Don't keep the process alive purely to fire a pending gate's timeout.
        entry.timer.unref?.();
      }
      entry.onAbort = () => this.denyEntry(key, this.abortReason(signal));
      this.pending.set(key, entry);
      // Announce the pending gate before wiring the abort listener, so it is
      // emitted even when `signal` is already aborted (that path removes it
      // right after, yielding a symmetric pending→resolved pair).
      this.emit({ type: 'pending', view: this.toView(entry) });
      if (signal?.aborted) entry.onAbort();
      else signal?.addEventListener('abort', entry.onAbort, { once: true });
    });
  }

  /** Resolve a pending gate from a glasses decision. `allow` lets the tool run;
   *  `deny` blocks it, surfacing `reason` as the tool result. 404 if unknown. */
  decide(
    threadId: string,
    toolCallId: string,
    action: 'allow' | 'deny',
    reason?: string,
  ): ApprovalDecisionResponse {
    const key = this.key(threadId, toolCallId);
    const entry = this.pending.get(key);
    if (!entry) return { ok: false, status: 404, error: 'Approval not found' };

    if (action === 'allow') {
      this.remove(key, entry);
      entry.resolve({ block: false });
    } else {
      this.denyEntry(key, reason?.trim() || 'Denied from glasses');
    }
    return { ok: true };
  }

  cancelThread(threadId: string, reason: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.threadId === threadId) this.denyEntry(key, reason);
    }
  }

  /** Deny a single pending gate (e.g. the glasses "dismiss" gesture).
   *  Returns false if no such gate is pending. */
  cancel(threadId: string, toolCallId: string, reason: string): boolean {
    const key = this.key(threadId, toolCallId);
    if (!this.pending.has(key)) return false;
    this.denyEntry(key, reason);
    return true;
  }

  pendingCount(threadId: string): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.threadId === threadId) count += 1;
    }
    return count;
  }

  hasPending(threadId: string): boolean {
    return this.pendingCount(threadId) > 0;
  }

  /** Enumerate every pending gate across all threads. Used by the glasses
   *  cockpit gateway to surface pending gates as approval cards. */
  listPending(): PendingApprovalView[] {
    return Array.from(this.pending.values(), (entry) => this.toView(entry));
  }

  private toView(entry: PendingApproval): PendingApprovalView {
    return {
      threadId: entry.threadId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      input: entry.input,
      cwd: entry.cwd,
      requestedAt: entry.requestedAt,
    };
  }

  private emit(event: ApprovalBrokerEvent): void {
    for (const listener of this.listeners) {
      // A misbehaving subscriber must never break gate resolution.
      try { listener(event); } catch { /* ignore */ }
    }
  }

  private denyEntry(key: string, reason: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.remove(key, entry);
    entry.resolve({ block: true, reason });
  }

  private remove(key: string, entry: PendingApproval): void {
    this.pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
    // Single choke point for every removal (allow / deny / cancel / abort /
    // timeout), so one resolved event fires per pending gate regardless of path.
    this.emit({ type: 'resolved', threadId: entry.threadId, toolCallId: entry.toolCallId });
  }

  private abortReason(signal?: AbortSignal): string {
    const reason = signal?.reason;
    if (typeof reason === 'string' && reason.trim()) return reason;
    if (reason instanceof Error && reason.message) return reason.message;
    return 'Run aborted before approval';
  }

  private key(threadId: string, toolCallId: string): string {
    return `${threadId}:${toolCallId}`;
  }
}

/** The built-in `question` tool has its own interactive glasses approval path
 *  (see ./questions.ts). Gating it here would double-prompt / deadlock, so it is
 *  always excluded from the Supervise gate. */
export const UNGATED_TOOL_NAMES = new Set(['question']);

/**
 * Extension that gates a chat session's tool calls behind the Supervise
 * approval flow. Registered per session; `isSupervised()` is read live at each
 * tool call so toggling Supervise mid-session takes effect immediately without
 * rebuilding the session. Returns `undefined` (allow) when the session isn't
 * supervised or the tool is exempt, so an unsupervised session pays nothing.
 */
export function createApprovalExtension(
  threadId: string,
  cwd: string,
  broker: ApprovalBroker,
  isSupervised: () => boolean,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      if (!isSupervised()) return undefined;
      if (UNGATED_TOOL_NAMES.has(event.toolName)) return undefined;
      // ctx.signal aborts the gate if the run is cancelled while awaiting.
      return broker.register(threadId, event.toolCallId, event.toolName, event.input, cwd, ctx.signal, timeoutMs);
    });
  };
}
