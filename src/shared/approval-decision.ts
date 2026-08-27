/**
 * Inline approval decisions (#374).
 *
 * A supervised session's tool-gate decisions are part of its story — the gate
 * is the whole reason the session is trustworthy — but they used to happen
 * only out of band (Approvals tab, push, glasses) and the transcript said
 * nothing. Each settled gate is now appended to the session event log as a
 * custom entry (so replays show the decision where it happened) and written to
 * the live NDJSON stream (so an open viewer sees it land).
 */
export const APPROVAL_DECISION_CUSTOM_TYPE = 'nexus.approval_decision' as const;

/** Who/what settled a gate. `human` = a person tapped Allow/Deny; `partner` =
 *  the partner assistant via the nexus-control lens; `timeout` = the
 *  default-deny fired; `aborted` = the run was cancelled around it. */
export type ApprovalDecisionBy = 'human' | 'partner' | 'timeout' | 'aborted';

export interface ApprovalDecisionEvent {
  threadId: string;
  toolCallId: string;
  toolName: string;
  /** Short human-readable input summary (never the raw payload). */
  inputSummary: string;
  outcome: 'allowed' | 'denied';
  answeredBy: ApprovalDecisionBy;
  /** Deny reason, when one was given. */
  reason?: string;
  decidedAt: string;
}

/** The projection clients receive on a transcript tool call that went through
 *  a gate. */
export interface ToolCallApproval {
  outcome: 'allowed' | 'denied';
  answeredBy: ApprovalDecisionBy;
  reason?: string;
  decidedAt?: string;
}

export type ApprovalDecisionWireEvent = {
  kind: 'approval_decision';
  decision: ApprovalDecisionEvent;
};
