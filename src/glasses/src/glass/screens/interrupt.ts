import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { moveHighlight } from 'even-toolkit/glass-nav'
import { line, truncate, centered, footer, DRILL, DOT_ACTIVE } from '../theme'
import type { GlassSnapshot, GlassActions } from '../shared'
import type { SessionSummary } from '../../types'

// The sessions blocking on a human — everything the interrupt speaks for. Once
// approvals are handled elsewhere (higher router priority), these are the
// notify-driven ones (idle / needs-input / question).
export function attentionSessions(snapshot: GlassSnapshot): SessionSummary[] {
  return snapshot.sessions.filter((s) => s.needsAttention)
}

// A stable key for the current attention set. While it equals the dismissed key the
// interrupt stays down; any change (new session needs you) re-raises it.
export function attentionKey(sessions: SessionSummary[]): string {
  return sessions.map((s) => s.id).sort().join(',')
}

// Whether the interrupt should currently take over the screen. Shared by the
// router (which screen) and AppGlasses (text vs image-hero page mode).
export function isInterruptActive(s: GlassSnapshot): boolean {
  const attn = attentionSessions(s)
  return attn.length > 0 && !s.activeSessionId && attentionKey(attn) !== s.dismissedAttentionKey
}

// Human-readable reason from the hub's attention payload.
const REASON: Record<string, string> = {
  permission_prompt: 'permission',
  idle_prompt: 'idle — waiting',
  agent_needs_input: 'needs input',
  elicitation_dialog: 'has a question',
}
export function reason(s: SessionSummary): string {
  const a = s.attention
  if (!a) return 'needs you'
  return REASON[a.type] || truncate(a.message || 'needs you', 30)
}

// Hard clip (no "~" ellipsis) — matches the list; the full title is one tap away.
function clip(text: string, n: number): string {
  return text.length > n ? text.slice(0, n).trimEnd() : text
}

// The one screen that's *pushed*, not pulled: a session needs you and there's no
// approval to act on. Centered, sparse, glanceable. tap → review, 2tap → dismiss.
export const interruptScreen: GlassScreen<GlassSnapshot, GlassActions> = {
  display(snapshot, nav) {
    const attn = attentionSessions(snapshot)
    if (attn.length === 0) return { lines: [line('')] }
    const idx = Math.min(nav.highlightedIndex, attn.length - 1)
    const s = attn[idx]!
    const name = s.title || s.project || s.id.slice(0, 8)

    const hint = attn.length > 1
      ? `tap ${DRILL} review   swipe ${DRILL} next`
      : `tap ${DRILL} review   2tap ${DRILL} dismiss`
    const counter = attn.length > 1 ? centered(`${idx + 1} of ${attn.length}`) : line('')

    // Exactly 10 lines: vertically balanced, footer pinned to the bottom row.
    return {
      lines: [
        line(''),
        line(''),
        centered(`${DOT_ACTIVE} ${clip(name, 32)}`),
        line(''),
        centered('NEEDS YOU'),
        centered(reason(s)),
        line(''),
        counter,
        line(''),
        footer(hint),
      ],
    }
  },

  action(action, nav, snapshot, ctx) {
    const attn = attentionSessions(snapshot)
    if (attn.length === 0) return nav
    const idx = Math.min(nav.highlightedIndex, attn.length - 1)
    const s = attn[idx]!
    const key = attentionKey(attn)

    if (action.type === 'HIGHLIGHT_MOVE') {
      return { ...nav, highlightedIndex: moveHighlight(idx, action.direction, attn.length - 1) }
    }
    if (action.type === 'SELECT_HIGHLIGHTED') {
      // Acknowledge this whole attention set, then dip into the session.
      ctx.dismissInterrupt(key)
      ctx.openSession(s.id)
      return { ...nav, highlightedIndex: 0 }
    }
    if (action.type === 'GO_BACK') {
      ctx.dismissInterrupt(key)
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
