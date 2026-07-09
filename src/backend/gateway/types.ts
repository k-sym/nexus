/**
 * Glasses cockpit wire types.
 *
 * These mirror `session-cockpit/glasses/src/types.ts` byte-for-byte so the
 * Even Realities G2 glasses app (and its web dashboard) can point at Nexus
 * with ZERO code changes — the gateway just has to serve these shapes.
 *
 * Do not "improve" these types to match Nexus's internal models; they are an
 * external contract owned by the glasses client.
 */

export interface Attention {
  type: string;
  message: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  project: string;
  lastPrompt: string;
  lastAssistant: string;
  lastActivityAt: number;
  turns: number;
  live: boolean;
  recent: boolean;
  needsAttention: boolean;
  attention: Attention | null;
  /** Nexus extension (ignored by the glasses): which store this came from. */
  kind?: 'chat' | 'assistant';
  /** Nexus extension (ignored by the glasses today; used by P3 grouping). */
  projectId?: string | null;
}

export interface TranscriptEvent {
  kind: 'user' | 'assistant_text' | 'tool_use';
  text?: string;
  name?: string;
  input?: unknown;
  ts?: number;
}

export interface SessionDetail {
  session: SessionSummary;
  events: TranscriptEvent[];
}

export interface Decision {
  action: 'allow' | 'deny' | 'answer';
  reason: string;
  answers?: Record<string, string>;
  decidedAt: number;
}

export interface Approval {
  id: string;
  kind: 'approval' | 'question';
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd: string;
  title: string;
  createdAt: number;
  decision: Decision | null;
}

/** The `tool_input` shape the glasses expect for a `kind:'question'` approval. */
export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export type SseEvent =
  | { type: 'hello'; armed: boolean; steerFocus: string | null; pending: Approval[] }
  | { type: 'pending'; approval: Approval }
  | { type: 'resolved'; id: string; action: string; reason: string }
  | { type: 'armed'; armed: boolean; reason?: string }
  | { type: 'notify'; notification: NotifyRecord };

export interface NotifyRecord {
  session_id: string;
  cwd: string;
  message: string;
  notification_type: string;
  needsAttention: boolean;
  at: number;
}
