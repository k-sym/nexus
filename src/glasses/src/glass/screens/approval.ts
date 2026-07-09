import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { moveHighlight } from 'even-toolkit/glass-nav'
import {
  line, separator, footer, padTo, truncate,
  SEP, DRILL, DOT_ACTIVE,
} from '../theme'
import type { GlassSnapshot, GlassActions } from '../shared'
import type { Approval } from '../../types'

function basename(p: string): string {
  return p.split('/').pop() || p
}

// Word-wrap into at most `maxLines` rows of `cols` chars, ellipsizing overflow.
function wrap(text: string, cols: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur.length === 0) cur = w.slice(0, cols)
    else if (cur.length + 1 + w.length <= cols) cur += ' ' + w
    else { out.push(cur); cur = w.slice(0, cols); if (out.length === maxLines - 1) break }
  }
  if (cur && out.length < maxLines) out.push(cur)
  if (out.length === maxLines) out[maxLines - 1] = truncate(out[maxLines - 1]!, cols)
  return out
}

// The "what" — the tool payload as a couple of context lines. The command/path is
// the thing you're actually judging, so it leads with the drill glyph.
function payloadLines(a: Approval): string[] {
  const inp = (a.tool_input ?? {}) as Record<string, unknown>
  if (a.tool_name === 'Bash' && typeof inp.command === 'string') {
    return wrap(String(inp.command), 40, 4).map((l, i) => (i === 0 ? `${DRILL} ${l}` : `  ${l}`))
  }
  if ((a.tool_name === 'Edit' || a.tool_name === 'Write') && typeof inp.file_path === 'string') {
    return [`${DRILL} ${truncate(String(inp.file_path), 40)}`]
  }
  return wrap(a.title, 40, 3).map((l, i) => (i === 0 ? `${DRILL} ${l}` : `  ${l}`))
}

// Highest-priority screen: shown whenever any approval is pending. Tap allows,
// double-tap denies, swipe cycles the queue. Nothing here auto-allows.
export const approvalScreen: GlassScreen<GlassSnapshot, GlassActions> = {
  display(snapshot, nav) {
    const q = snapshot.approvals
    if (q.length === 0) return { lines: [line('no approvals')] }
    const idx = Math.min(nav.highlightedIndex, q.length - 1)
    const a = q[idx]!

    const counter = q.length > 1 ? ` ${SEP} ${idx + 1} of ${q.length}` : ''
    const tool = (a.tool_name || 'tool').toUpperCase()
    const where = basename(a.cwd)

    const lines = [
      line(`${DOT_ACTIVE} APPROVE${counter}`, 'meta'),
      separator(),
      line(`${truncate(tool, 12)} ${SEP} ${truncate(where, 26)}`),
    ]
    for (const d of payloadLines(a)) lines.push(line(d))

    // Action strip: opposite gestures for opposite outcomes; nothing auto-fires.
    // (✓/✗ render as tofu on the G2 — confirmed on the simulator — so words carry it.)
    const decide = `tap ALLOW   ${SEP}   2tap DENY`
    const strip = q.length > 1
      ? [footer(decide), footer(`swipe ${DRILL} next in queue`)]
      : [footer(decide)]
    return { lines: padTo([...lines, ...strip]) }
  },

  action(action, nav, snapshot, ctx) {
    const q = snapshot.approvals
    if (q.length === 0) return nav
    const idx = Math.min(nav.highlightedIndex, q.length - 1)
    const a = q[idx]!

    if (action.type === 'HIGHLIGHT_MOVE') {
      return { ...nav, highlightedIndex: moveHighlight(idx, action.direction, q.length - 1) }
    }
    if (action.type === 'SELECT_HIGHLIGHTED') {
      ctx.allow(a.id)
      return { ...nav, highlightedIndex: 0 }
    }
    if (action.type === 'GO_BACK') {
      ctx.deny(a.id)
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
