import type { GlassScreen } from 'even-toolkit/glass-screen-router'
import { line, separator, footer, padTo, truncate, SEP, DRILL, BACK_CHAR } from '../theme'
import type { GlassSnapshot, GlassActions } from '../shared'
import type { TranscriptEvent } from '../../types'

// Line grammar: "›" you, "│" assistant, "»" a tool call. Three prefixes carry the
// whole transcript at a glance. (All three confirmed to render on the G2 sim.)
const P_USER = `${DRILL} `
const P_ASSISTANT = '│ '
const P_TOOL = '» '

const COLS = 44
const VISIBLE = 7

function basename(raw: unknown): string {
  return typeof raw === 'string' ? (raw.split('/').pop() || raw) : '?'
}

function wrap(text: string, prefix: string): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const indent = ' '.repeat(prefix.length)
  const out: string[] = []
  let cur = ''
  let first = true
  for (const w of words) {
    const pfx = first ? prefix : indent
    const room = COLS - pfx.length
    if (cur.length === 0) { cur = w.slice(0, room); continue }
    if (cur.length + 1 + w.length <= room) cur += ' ' + w
    else { out.push(pfx + cur); first = false; cur = w.slice(0, COLS - indent.length) }
  }
  if (cur) out.push((first ? prefix : indent) + cur)
  return out
}

function toolLine(ev: TranscriptEvent): string {
  const inp = (ev.input ?? {}) as Record<string, unknown>
  let suffix = ''
  if (typeof inp.file_path === 'string' || typeof inp.path === 'string') {
    suffix = `(${basename(inp.file_path ?? inp.path)})`
  } else if (typeof inp.command === 'string') {
    suffix = `(${truncate(String(inp.command), 28)})`
  } else if (typeof inp.pattern === 'string') {
    suffix = `(${truncate(String(inp.pattern), 28)})`
  }
  return `${P_TOOL}${ev.name ?? 'tool'}${suffix}`
}

function transcriptLines(events: TranscriptEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) {
    if (ev.kind === 'user') out.push(...wrap(ev.text ?? '', P_USER))
    else if (ev.kind === 'assistant_text') out.push(...wrap(ev.text ?? '', P_ASSISTANT))
    else if (ev.kind === 'tool_use') out.push(toolLine(ev))
  }
  return out
}

// Read-only session transcript. Swipe scrolls (offset held in nav.highlightedIndex,
// 0 = pinned to newest); double-tap returns to the list.
export const detailScreen: GlassScreen<GlassSnapshot, GlassActions> = {
  display(snapshot, nav) {
    const s = snapshot.sessions.find((x) => x.id === snapshot.activeSessionId)
    const title = s?.title || s?.project || snapshot.activeSessionId?.slice(0, 8) || 'session'

    const all = transcriptLines(snapshot.activeEvents)
    const maxOffset = Math.max(0, all.length - VISIBLE)
    const offset = Math.min(nav.highlightedIndex, maxOffset)
    const start = Math.max(0, all.length - VISIBLE - offset)
    const window = all.slice(start, start + VISIBLE)

    const scroll = maxOffset > 0 ? ` ${SEP} ${offset === 0 ? '▼' : '▲'}${offset}` : ''
    const lines = [
      line(`${BACK_CHAR} ${truncate(title, 30)}${scroll}`, 'meta'),
      separator(),
    ]
    if (all.length === 0) lines.push(line(''), line('  no transcript yet', 'meta'))
    else for (const l of window) lines.push(line(l))

    return { lines: padTo([...lines, footer(`swipe ${DRILL} scroll   2tap ${DRILL} back`)]) }
  },

  action(action, nav, snapshot, ctx) {
    if (action.type === 'HIGHLIGHT_MOVE') {
      // Swipe up = older (offset+), down = newer (offset-). Clamped at render.
      const delta = action.direction === 'up' ? 3 : -3
      const all = transcriptLines(snapshot.activeEvents)
      const maxOffset = Math.max(0, all.length - VISIBLE)
      const next = Math.max(0, Math.min(maxOffset, nav.highlightedIndex + delta))
      return { ...nav, highlightedIndex: next }
    }
    if (action.type === 'GO_BACK') {
      ctx.closeDetail()
      return { ...nav, highlightedIndex: 0 }
    }
    return nav
  },
}
