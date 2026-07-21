// Markdown → plain text for the firmware renderer.
//
// The lens has ONE font, no styling of any kind, and about seven readable lines.
// Agent replies arrive as Markdown, so every leftover `**` or backtick is a word
// you don't get to read — the delimiters cost real space and buy nothing, because
// the firmware can't render the emphasis they describe. This flattens the syntax
// and keeps the words.
//
// Deliberately NOT a Markdown parser: it's a line/inline pass tuned for prose
// replies. It never has to round-trip, only to read well at a glance.

// Inline code is lifted out FIRST and put back LAST, so the emphasis passes can't
// mangle a code span's contents (`foo_bar_baz` would otherwise lose its underscores).
const CODE_SLOT = '\u0000'

/** A table separator row — `|---|:--:|` — carries no words, only alignment. */
function isTableRule(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(line)
}

/** A thematic break: three or more -, * or _ on their own. */
function isThematicBreak(line: string): boolean {
  return /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)
}

/** Strip the block-level marker off one line (headings, quotes, bullets, tables). */
function flattenBlock(line: string): string | null {
  if (isThematicBreak(line) || isTableRule(line)) return null // nothing to read

  let out = line
  out = out.replace(/^\s{0,3}#{1,6}\s+/, '')       // # Heading
  out = out.replace(/\s+#+\s*$/, '')                // closing #s of a closed ATX heading
  out = out.replace(/^(?:\s{0,3}>\s?)+/, '')        // > quote, including nested
  out = out.replace(/^(\s*)[-*+]\s+/, '$1• ')  // - bullet → • bullet

  // A table row becomes one readable line: cells joined by the separator the rest
  // of the HUD already uses for "field · field".
  if (/^\s*\|.*\|\s*$/.test(out)) {
    const cells = out.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean)
    if (cells.length) out = cells.join(' · ')
  }

  return out
}

/** Flatten the inline syntax on one line. Order matters: images before links
 *  (an image is a link with a bang), bold before italic (`**` before `*`). */
function flattenInline(line: string): string {
  let out = line
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')          // ![alt](src) → alt
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')           // [text](href) → text
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')   // <https://…> → the url
  // Every emphasis pass requires the delimiter to HUG its text (`\S…\S`), the same
  // rule Markdown itself uses — otherwise "a * b * c" reads as emphasis and loses
  // its stars, and prose that multiplies or globs gets quietly mangled.
  out = out.replace(/~~(\S(?:[^\n]*?\S)?)~~/g, '$1')              // ~~struck~~
  out = out.replace(/\*\*(\S(?:[^\n]*?\S)?)\*\*/g, '$1')          // **bold**
  out = out.replace(/__(\S(?:[^\n]*?\S)?)__/g, '$1')              // __bold__
  out = out.replace(/(^|[^*\\])\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, '$1$2') // *italic*
  // _italic_ additionally needs word boundaries, so snake_case survives intact.
  out = out.replace(/(^|[^\w\\])_(\S(?:[^_\n]*\S)?)_(?!\w)/g, '$1$2')
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')     // \* → *
  return out
}

/**
 * Flatten Markdown to the plain text the G2 firmware can actually render.
 * Fenced code blocks keep their contents verbatim (the code is often the answer)
 * but lose their fences; everything else loses its syntax and keeps its words.
 */
export function toGlassText(md: string): string {
  if (!md) return ''

  // 1. Lift inline code spans out of harm's way.
  const spans: string[] = []
  const lifted = md.replace(/\r\n/g, '\n').replace(/`+([^`\n]+?)`+/g, (_m, body: string) => {
    spans.push(body)
    return `${CODE_SLOT}${spans.length - 1}${CODE_SLOT}`
  })

  // 2. Walk lines, tracking fenced code so its contents stay untouched.
  const out: string[] = []
  let inFence = false
  for (const line of lifted.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue } // drop the fence itself
    if (inFence) { out.push(line); continue }
    const block = flattenBlock(line)
    if (block === null) continue
    out.push(flattenInline(block))
  }

  // 3. Put the code spans back, then normalise whitespace: trailing spaces are
  //    invisible but still cost wrap budget, and a run of blank lines costs rows.
  return out
    .join('\n')
    .replace(new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'), (_m, i: string) => spans[Number(i)] ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
