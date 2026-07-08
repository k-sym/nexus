import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { buildScrollableList } from 'even-toolkit/glass-display-builders'
import { moveHighlight } from 'even-toolkit/glass-nav'
import {
  line, separator, footer, padTo, truncate,
  SEP, DRILL, DOT_ACTIVE, DOT_BUSY, DOT_IDLE,
} from '../theme'
import type { GlassSnapshot, GlassActions } from '../shared'
import type { ConnectionStatus, SessionSummary } from '../../types'

const CONN_DOT: Record<ConnectionStatus, string> = {
  ok: DOT_ACTIVE, unknown: DOT_BUSY, connecting: DOT_BUSY, error: '×',
}

function sessionDot(s: SessionSummary): string {
  if (s.needsAttention) return DOT_ACTIVE
  if (s.live) return DOT_BUSY // backed by a running process
  return DOT_IDLE
}

// Compact relative age — the right-hand "how warm" cue for calm rows.
function age(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// One row: "● name · <state>". The highlighted row gets its ▶ caret for free from
// buildScrollableList (inverted → "▶ " prefix), so we never add a cursor here.
// Hard clip — no "~" ellipsis. even-toolkit's truncate() tags every cut with a
// trailing ~, which is noisy on long AI titles; a clean cut reads better and the
// full title is one tap away in the transcript.
function clip(text: string, n: number): string {
  return text.length > n ? text.slice(0, n).trimEnd() : text
}

function label(s: SessionSummary): string {
  const name = s.title || s.project || s.id.slice(0, 8)
  // ⚠ renders as tofu on the G2 (confirmed on sim); the solid ● dot is the
  // attention signal, "needs you" the words.
  const meta = s.needsAttention ? 'needs you' : age(s.lastActivityAt)
  const room = 44 - 2 - 3 - meta.length // "● " prefix + " · " join + meta
  return `${sessionDot(s)} ${clip(name, room)} ${SEP} ${meta}`
}

// Home screen: the session catalog. The hub sorts by lastActivity, so attention
// sessions surface near the top; the ● dot + "⚠ you" make them scannable.
export const listScreen: GlassScreen<GlassSnapshot, GlassActions> = {
  display(snapshot, nav) {
    const attn = snapshot.sessions.filter((s) => s.needsAttention).length
    const state = snapshot.armed ? 'armed' : 'standby'
    const title = attn ? `COCKPIT ${SEP} ${attn} need you` : `COCKPIT ${SEP} ${state}`

    const lines = [
      line(`${CONN_DOT[snapshot.connection]} ${truncate(title, 30)}`, 'meta'),
      separator(),
    ]

    if (snapshot.error) {
      lines.push(line(`! ${truncate(snapshot.error, 42)}`))
    }

    if (snapshot.sessions.length === 0) {
      lines.push(line(''), line('  no sessions found'), line('  is the hub running?', 'meta'))
    } else {
      const items = snapshot.sessions
      const highlighted = Math.min(nav.highlightedIndex, items.length - 1)
      lines.push(
        ...buildScrollableList({
          items,
          highlightedIndex: highlighted,
          maxVisible: 6,
          formatter: (s) => label(s),
        }),
      )
    }

    // Footer doubles as the ARM control hint (2-tap toggles it from here).
    const hint = snapshot.armed
      ? fieldHint('tap open', '2tap disarm', 'swipe')
      : fieldHint('tap open', '2tap ARM', 'swipe')
    return { lines: padTo([...lines, footer(hint)]) }
  },

  action(action, nav, snapshot, ctx) {
    const max = snapshot.sessions.length - 1

    if (action.type === 'HIGHLIGHT_MOVE') {
      if (max < 0) return nav
      return { ...nav, highlightedIndex: moveHighlight(nav.highlightedIndex, action.direction, max) }
    }

    if (action.type === 'SELECT_HIGHLIGHTED') {
      if (max < 0) return nav
      const s = snapshot.sessions[Math.min(nav.highlightedIndex, max)]
      if (s) ctx.openSession(s.id)
      return { ...nav, highlightedIndex: 0 }
    }

    if (action.type === 'GO_BACK') {
      // Quick global control: arm/disarm routing-to-me from the home screen.
      ctx.toggleArmed()
      return nav
    }

    return nav
  },
}

// Local helper: join footer hints with the drill glyph so the affordances read
// as one action strip ("tap open › 2tap ARM › swipe").
function fieldHint(...parts: string[]): string {
  return parts.join(` ${DRILL} `)
}
