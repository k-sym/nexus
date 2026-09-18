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

// Nexus extension (#477): a partner attention item as the gateway serves it for
// the lens — what the hero shows and the verbs it may offer. `lens_verbs` is the
// partner's per-surface contract; the glasses render it and add nothing.
export type AttentionVerb = 'draft' | 'open' | 'snooze' | 'dismiss'

export interface AttentionItem {
  id: string
  kind: string
  title: string
  why: string
  status: string
  proposed_verb: string
  verbs: string[]
  lens_verbs: string[]
  alert_seq: number
  created_at: number
  snoozed_until: number | null
  /** `notice` (a glance is "seen") or `action`; an older gateway sends neither = action (#477 D36). */
  category?: 'notice' | 'action' | (string & {})
  /** Slice 8 (D58): what Read can show without a fetch — the partner's clipped body. */
  body?: string | null
  /** A vault page exists behind the item (`links.vault_page`); the page is fetched on Read. */
  has_page?: boolean
  /** The producer's suggested project (slug or badge) for a To-do from the lens (D62). */
  suggested_project?: string | null
}

/** A project as the gateway lists it for the lens's To-do picker (D62). */
export interface LensProject { id: string; slug: string; name: string; badge: string }

/** The latest message behind a mail item, as the partner's thread read returns it. */
export interface LensThreadMessage { from?: string; from_name?: string; subject?: string; date?: string; body: string }


