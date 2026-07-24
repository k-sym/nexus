/**
 * Tool-permission gate.
 *
 * Each tool call is intercepted before it executes (via the agent SDK's
 * `beforeToolCall` → extension `tool_call` hook) and put to the session's tool
 * policy (see ./tool-policy.ts). Calls the policy answers `confirm` — which is
 * every gateable call when the thread is supervised — are parked here as a
 * pending approval; `allow` runs, `deny` blocks outright. The glasses cockpit
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
import { categorizeTool, isSideEffectful, resolveToolDecision, type ToolPolicyResolver } from './tool-policy.js';
import { NULL_APPROVAL_AUDIT, summarizeToolInput, type ApprovalAudit, type ToolDecisionRecord } from '../approvals/audit.js';

export { UNGATED_TOOL_NAMES } from './tool-policy.js';

/** How a parked gate was settled — for the audit trail. `human` = a person
 *  allowed/denied it (from the UI or the glasses); `timeout` = the default-deny
 *  fired; `aborted` = the run was cancelled, the thread dropped, or the signal
 *  aborted. */
export type ApprovalAnsweredBy = 'human' | 'timeout' | 'aborted';

/** The value returned to the SDK's `beforeToolCall`. `block:false` lets the
 *  tool run; `block:true` skips it and surfaces `reason` as the tool result.
 *  `answeredBy` records how a parked gate resolved (absent for gates that never
 *  parked). */
export interface ApprovalDecision {
  block: boolean;
  reason?: string;
  answeredBy?: ApprovalAnsweredBy;
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

/** Time a tool-gate waits for Allow/Deny before defaulting to DENY when nobody
 *  is watching. Tuned for the glasses: if the G2 is off or out of range, the
 *  turn should fail safe reasonably quickly rather than hang. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * The same wait, but while an interactive client is attached (the Nexus UI
 * holding the approvals stream open).
 *
 * A laptop user is not the glasses availability model: they may be reading the
 * diff, switching windows, or thinking. Denying their turn after five minutes
 * because they took a phone call is a worse failure than making them wait.
 *
 * This does NOT become "wait indefinitely" — an attached client can vanish
 * without a clean disconnect (a sleeping laptop, a dropped Tailscale link), and
 * a gate with no deadline at all would wedge the turn until someone noticed.
 */
export const ATTENDED_APPROVAL_TIMEOUT_MS = 30 * 60_000;

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
  /** True when the caller let the broker pick the timeout, so it tracks client
   *  presence. An explicitly-supplied timeout is the caller's contract and is
   *  never rescheduled underneath them. */
  presenceDriven: boolean;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<ApprovalBrokerListener>();
  /** Number of attached interactive clients (Nexus UI approval streams).
   *  Drives how long presence-driven gates wait before defaulting to DENY. */
  private clients = 0;

  /**
   * Register an attached interactive client. Returns a detach function; call it
   * exactly once when the client goes away.
   *
   * Attaching or detaching reschedules every presence-driven gate already
   * pending, so a gate parked before you opened the UI gets the longer window
   * too, and gates outlive a closing client by the unattended timeout rather
   * than the attended one.
   */
  attachClient(): () => void {
    this.clients += 1;
    if (this.clients === 1) this.reschedulePresenceDriven();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.clients = Math.max(0, this.clients - 1);
      if (this.clients === 0) this.reschedulePresenceDriven();
    };
  }

  /** Attached interactive clients. Exposed for diagnostics and tests. */
  clientCount(): number {
    return this.clients;
  }

  /** The wait a presence-driven gate currently gets. */
  private currentTimeoutMs(): number {
    return this.clients > 0 ? ATTENDED_APPROVAL_TIMEOUT_MS : DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /**
   * Re-arm the timers of presence-driven gates against the new window, counting
   * the time they have already waited. A gate that has outlived the new window
   * (attended for longer than the unattended timeout, then the client left) is
   * denied now — nobody is there to answer it, which is exactly the case the
   * default-deny exists for.
   */
  private reschedulePresenceDriven(): void {
    const timeoutMs = this.currentTimeoutMs();
    // Snapshot: denyEntry mutates `pending` while we iterate.
    for (const [key, entry] of [...this.pending]) {
      if (!entry.presenceDriven) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      const remaining = entry.requestedAt + timeoutMs - Date.now();
      if (remaining <= 0) {
        this.denyEntry(key, `Approval timed out after ${Math.round(timeoutMs / 1000)}s — auto-denied`, 'timeout');
        continue;
      }
      entry.timer = setTimeout(() => {
        this.denyEntry(key, `Approval timed out after ${Math.round(timeoutMs / 1000)}s — auto-denied`, 'timeout');
      }, remaining);
      entry.timer.unref?.();
    }
  }

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
    /** Omit to let the broker pick based on client presence (the normal path).
     *  Supplying a value pins this gate to it for its whole life. */
    explicitTimeoutMs?: number,
  ): Promise<ApprovalDecision> {
    const key = this.key(threadId, toolCallId);
    if (this.pending.has(key)) return Promise.reject(new Error(`Approval already pending: ${toolCallId}`));

    const presenceDriven = explicitTimeoutMs === undefined;
    const timeoutMs = explicitTimeoutMs ?? this.currentTimeoutMs();

    return new Promise<ApprovalDecision>((resolve) => {
      const entry: PendingApproval = {
        threadId, toolCallId, toolName, input, cwd,
        requestedAt: Date.now(), resolve, signal, presenceDriven,
      };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          this.denyEntry(key, `Approval timed out after ${Math.round(timeoutMs / 1000)}s — auto-denied`, 'timeout');
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
      entry.resolve({ block: false, answeredBy: 'human' });
    } else {
      this.denyEntry(key, reason?.trim() || 'Denied from glasses', 'human');
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

  /** `answeredBy` defaults to `aborted` — the reason most callers (cancel,
   *  cancelThread, abort, drop) pass through this path. Timeout and human deny
   *  pass their own. */
  private denyEntry(key: string, reason: string, answeredBy: ApprovalAnsweredBy = 'aborted'): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.remove(key, entry);
    entry.resolve({ block: true, reason, answeredBy });
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

/**
 * Extension that applies the session's tool policy to each tool call.
 *
 * The policy resolver is consulted live at every call — never captured at
 * session build — so a policy change (including toggling Supervise) takes
 * effect on the next tool call without rebuilding the session.
 *
 *   - `allow`   → `undefined`, the SDK runs the tool. An allowed call pays
 *                 nothing beyond the resolver, which is the common path.
 *   - `confirm` → park on the broker and await a human decision.
 *   - `deny`    → block immediately. No gate is registered and nothing waits,
 *                 so a denied capability costs no round trip and cannot sit
 *                 there until the 5-minute default-deny timeout fires.
 */
export function createApprovalExtension(
  threadId: string,
  cwd: string,
  broker: ApprovalBroker,
  policy: ToolPolicyResolver,
  /** Tests pin this; production omits it so gates follow client presence. */
  timeoutMs?: number,
  /** Records decisions for the audit trail (#281). Defaults to a no-op sink. */
  audit: ApprovalAudit = NULL_APPROVAL_AUDIT,
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const request = { toolName: event.toolName, input: event.input };
      // resolveToolDecision owns the fail-closed behaviour: a resolver that
      // throws or returns nonsense degrades to `confirm` for side-effectful
      // tools rather than falling through to allow.
      const decision = resolveToolDecision(policy, request);

      // The source is best-effort — a throwing/absent explainer must not affect
      // the call, only leave the record less specific.
      let trace;
      try { trace = policy.explain?.(request); } catch { trace = undefined; }

      const base = {
        threadId,
        cwd,
        toolName: event.toolName,
        category: categorizeTool(event.toolName),
        inputSummary: summarizeToolInput(event.input),
        decision,
        source: trace?.source ?? 'default',
        ...(trace?.rule?.tool ? { ruleTool: trace.rule.tool } : {}),
        ...(trace?.rule?.when ? { ruleWhen: trace.rule.when } : {}),
      } satisfies Omit<ToolDecisionRecord, 'outcome' | 'answeredBy'>;

      // Skip the noise: a plain allow of a read-only tool with no rule is not a
      // "gated decision" worth a row. Everything else — confirms, denies, and
      // allows that a rule drove or that touch the host — is recorded.
      const worthRecording = decision !== 'allow' || trace?.source === 'rule' || isSideEffectful(event.toolName);

      if (decision === 'allow') {
        if (worthRecording) audit.record({ ...base, outcome: 'allowed', answeredBy: 'policy' });
        return undefined;
      }
      if (decision === 'deny') {
        audit.record({ ...base, outcome: 'denied', answeredBy: 'policy' });
        return { block: true, reason: `Blocked by policy: \`${event.toolName}\` is not permitted in this session.` };
      }

      // confirm: park on the broker (ctx.signal aborts the gate on cancel), then
      // record how it resolved — allowed/denied and by whom.
      const result = await broker.register(threadId, event.toolCallId, event.toolName, event.input, cwd, ctx.signal, timeoutMs);
      audit.record({
        ...base,
        outcome: result.block ? 'denied' : 'allowed',
        answeredBy: result.answeredBy ?? 'human',
      });
      return result;
    });
  };
}
