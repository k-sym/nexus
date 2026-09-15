// Text segmentation. Chunks follow the markdown structure: one chunk per heading
// section, prefixed with a breadcrumb line ("Title › H1 › H2") so a parent chunk shown
// at recall time stands on its own. Sections over the word cap are sized by paragraph,
// then sentence, then a plain word window; no overlap (heading alignment is the
// continuity mechanism). Sentences are derived from the section text only, never from
// the breadcrumb, so the sentence index stays clean.
//
// The 180-word cap is a guard, not a retrieval choice: the local embedder is launched
// with --ubatch-size 1024 (see README local-model-stack), which comfortably fits 180
// words even when dense/technical text tokenizes above 1 token/word, and keeps a
// margin below the stock default ubatch of 512 so a misconfigured stack dead-letters
// loudly instead of silently truncating.

export const DEFAULT_CAP_WORDS = 180;
/** Never size a section below this many words, whatever the breadcrumb costs. */
const MIN_CAP_WORDS = 40;
/** Path depth kept in the breadcrumb; deeper headings replace the last entry. */
const MAX_PATH_DEPTH = 3;
export const BREADCRUMB_SEP = " › ";

export interface ChunkOpts {
  wordsPerChunk?: number;
  overlap?: number;
}

export interface Section {
  /** Heading path from the document root, H1 first, at most MAX_PATH_DEPTH deep. */
  path: string[];
  text: string;
}

export interface DocumentChunk {
  /** Stored and embedded: breadcrumb line, blank line, section piece. */
  text: string;
  /** The section piece alone; sentences are split from this. */
  source: string;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Plain word window. Default overlap is 0; the option remains for callers that want one. */
export function splitIntoChunks(text: string, opts: ChunkOpts = {}): string[] {
  const wordsPerChunk = opts.wordsPerChunk ?? DEFAULT_CAP_WORDS;
  const overlap = opts.overlap ?? 0;
  const step = Math.max(1, wordsPerChunk - overlap);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= wordsPerChunk) return [words.join(" ")];

  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + wordsPerChunk).join(" "));
    if (start + wordsPerChunk >= words.length) break;
  }
  return chunks;
}

export function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace, and on newlines.
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5);
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})/;

/**
 * Walk the body line by line and cut it at ATX headings. Headings inside fenced code
 * are ignored. Heading lines are consumed into the path and never appear in section
 * text; a heading with no text under it (a parent of subsections, or consecutive
 * headings) yields no section. A body with no headings is one section with an empty path.
 */
export function splitMarkdownSections(body: string): Section[] {
  const sections: Section[] = [];
  // Stack of open headings by level, not by absolute depth: a note whose headings
  // start at H2 (session roll-ups) must not nest its second H2 under the first.
  const stack: Array<{ level: number; text: string }> = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length > 0) sections.push({ path: stack.map((h) => h.text), text });
    buf = [];
  };

  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      buf.push(line);
      continue;
    }
    if (fence !== null) {
      buf.push(line);
      continue;
    }
    const h = line.match(HEADING);
    if (!h) {
      buf.push(line);
      continue;
    }
    flush();
    const level = h[1].length;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length >= MAX_PATH_DEPTH) stack.pop(); // deeper headings replace the last entry
    stack.push({ level, text: h[2].trim() });
  }
  flush();
  return sections;
}

/** "Title › H1 › H2". The leading path entry is dropped when it repeats the title. */
export function breadcrumb(title: string, path: string[]): string {
  const t = title.trim();
  const rest = path[0] !== undefined && path[0].trim().toLowerCase() === t.toLowerCase() ? path.slice(1) : path;
  return [t, ...rest].filter((s) => s.length > 0).join(BREADCRUMB_SEP);
}

/** Greedily pack units in order into pieces of at most `cap` words; oversized units are split by `splitUnit`. */
function pack(units: string[], cap: number, splitUnit: (u: string) => string[]): string[] {
  const pieces: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  const flush = () => {
    if (cur.length > 0) pieces.push(cur.join("\n\n"));
    cur = [];
    curWords = 0;
  };
  for (const unit of units) {
    const w = countWords(unit);
    if (w === 0) continue;
    if (w > cap) {
      flush();
      pieces.push(...splitUnit(unit));
      continue;
    }
    if (curWords + w > cap) flush();
    cur.push(unit);
    curWords += w;
  }
  flush();
  return pieces;
}

/**
 * Size one section under `cap` words: whole if it fits, else by paragraph, then by
 * sentence, then by a plain word window. No overlap at any level.
 */
export function sizeSection(text: string, cap: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (countWords(trimmed) <= cap) return [trimmed];
  const byWindow = (s: string) => splitIntoChunks(s, { wordsPerChunk: cap, overlap: 0 });
  const bySentence = (p: string) => pack(splitIntoSentences(p), cap, byWindow).map((s) => s.replace(/\n\n/g, " "));
  return pack(trimmed.split(/\n{2,}/), cap, bySentence);
}

/**
 * The whole document → stored chunks. Each chunk's `text` is the breadcrumb, a blank
 * line, then a piece of one section; `source` is the piece alone. The word cap applies
 * to `text`, breadcrumb included.
 */
export function chunkDocument(title: string, body: string, capWords = DEFAULT_CAP_WORDS): DocumentChunk[] {
  const out: DocumentChunk[] = [];
  for (const section of splitMarkdownSections(body)) {
    const crumb = breadcrumb(title, section.path);
    const cap = Math.max(MIN_CAP_WORDS, capWords - countWords(crumb));
    for (const piece of sizeSection(section.text, cap)) {
      out.push({ text: crumb.length > 0 ? `${crumb}\n\n${piece}` : piece, source: piece });
    }
  }
  return out;
}
