// HUD visual vocabulary for the Session Cockpit glasses layer.
//
// TEXT-MODE REALITY (see even-toolkit dist/glasses/types.js `renderTextPageLine`):
//   • Every line is prefixed with two spaces; `inverted:true` swaps that for "▶ ".
//     That caret is the ONLY selection/emphasis primitive text mode gives us —
//     there is no black-on-phosphor inversion and no dimming here (`meta` and
//     `normal` render identically). Real inversion/dim needs the image-tile path.
//   • `separator()` always renders as "  " + "─"×27 — a fixed short rule.
//   • The first non-separator line gets an auto-appended right-aligned clock, so
//     keep headers short and never right-align our own status onto that row.
//
// Glyph lexicon — CONFIRMED to render on the G2 via the simulator (2026-07-06):
//   ●  attention / armed / active     ◐  live / running        ○  idle / disarmed
//   ▶  row cursor (via inverted)      ▲ ▼  scroll indicators
//   ›  drill-in / user line           ‹  back                  ·  field join
//   │  assistant line                 »  tool line             ◆  diamond
//   →  arrow   ±  plus-minus          ═ ─  gauge   ~  ellipsis (even-toolkit)
// TOFU — render BLANK on the G2, never use: ✓ ✗ ⚠ ▸ ⟩ ❯ ⌘  (use words / the ● dot).

import { line, separator, type DisplayLine } from 'even-toolkit/types'
import { truncate } from 'even-toolkit/text-utils'
import { SEP, DRILL, BACK_CHAR, fieldJoin, progressBar } from 'even-toolkit/glass-format'

export { line, separator, truncate, SEP, DRILL, BACK_CHAR, fieldJoin, progressBar }
export type { DisplayLine }

export const DOT_ACTIVE = '●'
export const DOT_BUSY = '◐'
export const DOT_IDLE = '○'

// The G2 text page fits 10 lines. Keep every screen within that budget.
export const G2_LINES = 10

/** A meta-styled footer hint (rendered same as normal in text mode, but tagged
 *  so a richer renderer can dim it). Truncated to the safe line width. */
export function footer(hint: string): DisplayLine {
  return line(truncate(hint, 44), 'meta')
}

/**
 * Header block: a short title line + the fixed separator. Kept deliberately short
 * so the auto-injected clock fits on the title row. Status belongs in the title
 * text (e.g. a leading connection dot), NOT right-aligned here.
 */
export function header(title: string): DisplayLine[] {
  return [line(truncate(title, 30), 'meta'), separator()]
}

/** Pad a line list up to `total` (so the footer lands on a stable row), then clamp. */
export function padTo(lines: DisplayLine[], total = G2_LINES): DisplayLine[] {
  const out = [...lines]
  while (out.length < total) out.push(line(''))
  return out.slice(0, total)
}

/** A centered line (best-effort: text mode left-pads by eye, not pixels). The G2
 *  text page fits ~46 chars incl. the 2-space prefix, so center against that. */
export function centered(text: string, width = 46): DisplayLine {
  const t = truncate(text, width)
  const pad = Math.max(0, Math.floor((width - t.length) / 2))
  return line(' '.repeat(pad) + t)
}
