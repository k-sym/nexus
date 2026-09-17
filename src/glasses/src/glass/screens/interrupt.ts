import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { moveHighlight } from 'even-toolkit/glass-nav'
import { line, truncate, centered, footer, DRILL, DOT_ACTIVE } from '../theme'
import type { GlassSnapshot, GlassActions } from '../shared'
import type { SessionSummary } from '../../types'
import { attentionEntries, attentionKey, heroHeadline, itemReason, tapPlan, type AttentionEntry } from '../attention'

export { attentionKey }

// The sessions blocking on a human. Once approvals are handled elsewhere (higher
// router priority), these are the notify-driven ones (idle / needs-input / question).
export function attentionSessions(snapshot: GlassSnapshot): SessionSummary[] {
  return snapshot.sessions.filter((s) => s.needsAttention)
}

// Everything the interrupt speaks for (#477): those sessions, then the partner's
// open attention items. One hero, two sources, the partner's lens verbs as gestures.
export function attentionEntriesOf(snapshot: GlassSnapshot): AttentionEntry[] {
  return attentionEntries(snapshot.sessions, snapshot.attention)
}

// Whether the interrupt should currently take over the screen. Shared by the
// router (which screen) and AppGlasses (text vs image-hero page mode).
export function isInterruptActive(s: GlassSnapshot): boolean {
  const entries = attentionEntriesOf(s)
  return entries.length > 0 && !s.activeSessionId && attentionKey(entries) !== s.dismissedAttentionKey
}

// Headline and subline for an entry: a session's title and its hub reason; an
// item's title and its why.
export function entryName(entry: AttentionEntry): string {
  if (entry.kind === 'item') return entry.item.title
  const s = entry.session
  return s.title || s.project || s.id.slice(0, 8)
}
export function entryReason(entry: AttentionEntry): string {
  return entry.kind === 'item' ? truncate(itemReason(entry.item), 30) : reason(entry.session)
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
    const attn = attentionEntriesOf(snapshot)
    if (attn.length === 0) return { lines: [line('')] }
    const idx = Math.min(nav.highlightedIndex, attn.length - 1)
    const entry = attn[idx]!
    const name = entryName(entry)
    const plan = tapPlan(entry)

    // The gesture labels come from the entry: a session reviews, an item runs its
    // first lens verb (Draft / Snooze / Dismiss) — never a verb the client invents.
    const hint = attn.length > 1
      ? `tap ${DRILL} ${plan.tapLabel.toLowerCase()}   swipe ${DRILL} next`
      : `tap ${DRILL} ${plan.tapLabel.toLowerCase()}   2tap ${DRILL} ${plan.doubleTapLabel.toLowerCase()}`
    const counter = attn.length > 1 ? centered(`${idx + 1} of ${attn.length}`) : line('')

    // Exactly 10 lines: vertically balanced, footer pinned to the bottom row.
    return {
      lines: [
        line(''),
        line(''),
        centered(`${DOT_ACTIVE} ${clip(name, 32)}`),
        line(''),
        centered(heroHeadline(entry)),
        centered(entryReason(entry)),
        line(''),
        counter,
        line(''),
        footer(hint),
      ],
    }
  },

  action(action, nav, snapshot, ctx) {
    const attn = attentionEntriesOf(snapshot)
    if (attn.length === 0) return nav
    const idx = Math.min(nav.highlightedIndex, attn.length - 1)
    const entry = attn[idx]!
    const key = attentionKey(attn)

    if (action.type === 'HIGHLIGHT_MOVE') {
      return { ...nav, highlightedIndex: moveHighlight(idx, action.direction, attn.length - 1) }
    }
    if (action.type === 'SELECT_HIGHLIGHTED') {
      // Acknowledge this whole attention set, then act on the entry.
      ctx.dismissInterrupt(key)
      if (entry.kind === 'session') {
        ctx.openSession(entry.id)
      } else {
        const plan = tapPlan(entry)
        if (plan.tapVerb) ctx.resolveAttention(entry.id, plan.tapVerb)
      }
      return { ...nav, highlightedIndex: 0 }
    }
    if (action.type === 'GO_BACK') {
      ctx.dismissInterrupt(key)
      if (entry.kind === 'item') {
        const plan = tapPlan(entry)
        if (plan.doubleTapVerb) ctx.resolveAttention(entry.id, plan.doubleTapVerb)
      }
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
