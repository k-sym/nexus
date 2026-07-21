// Types mirror the session-cockpit hub (apps/session-cockpit/hub/server.mjs).

export interface Attention {
  type: string
  message: string
}

export interface SessionSummary {
  id: string
  title: string
  cwd: string
  project: string
  lastPrompt: string
  lastAssistant: string
  lastActivityAt: number
  turns: number
  live: boolean    // backed by a running Claude Code process right now
  recent: boolean  // active within the hub's RECENT_MS window
  needsAttention: boolean
  attention: Attention | null
  // Nexus extensions (the gateway sends these; the flat web dashboard ignores them,
  // the Phase-3 glasses nav groups on them).
  kind?: 'chat' | 'assistant'      // which store the session came from
  projectBadge?: string            // the project's rail badge (up to 3 chars), as on the desktop
  projectId?: string | null        // stable project key for grouping (null for Assistant)
}

export interface TranscriptEvent {
  kind: 'user' | 'assistant_text' | 'tool_use'
  text?: string
  name?: string
  input?: unknown
  ts?: number
}

export interface SessionDetail {
  session: SessionSummary
  events: TranscriptEvent[]
}

export interface Decision {
  action: 'allow' | 'deny'
  reason: string
  decidedAt: number
}

export interface Approval {
  id: string
  kind: 'approval' | 'question' // 'question' = AskUserQuestion (answered with text, not allow/deny)
  session_id: string
  tool_name: string
  tool_input: unknown
  cwd: string
  title: string
  createdAt: number
  decision: Decision | null
}

// The shape of AskUserQuestion's tool_input (only the fields we render/answer).
export interface AskUserQuestionInput {
  questions?: {
    question: string
    header?: string
    multiSelect?: boolean
    allowOther?: boolean // free-text ("Other") answer permitted → show the custom path
    options?: { label: string; description?: string }[]
  }[]
}

export interface NotifyRecord {
  session_id: string
  cwd: string
  message: string
  notification_type: string
  needsAttention: boolean
  at: number
}

// Server-Sent Events from GET /api/events
export type SseEvent =
  | { type: 'hello'; armed: boolean; steerFocus: string | null; pending: Approval[] }
  | { type: 'pending'; approval: Approval }
  | { type: 'resolved'; id: string; action: string; reason: string }
  | { type: 'armed'; armed: boolean; reason?: string }
  | { type: 'notify'; notification: NotifyRecord }
  // Phase 4c: a free-text steer was routed to a session (delivered to a parked Stop
  // hook, or queued for its next turn); and which session is armed to park.
  | { type: 'steer'; session_id: string; delivered: boolean }
  | { type: 'steerFocus'; session_id: string | null }

export type ConnectionStatus = 'unknown' | 'connecting' | 'ok' | 'error'
