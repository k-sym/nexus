// Fallback title for a note without frontmatter `title:`. Precedence, unchanged from
// the original ingest code: fence-aware H1 → first usable line → filename. The title is
// FTS-indexed, shown in the memory list, and since PR #479 it is the first breadcrumb
// entry embedded in every chunk, so it must be one clean line of prose.
import { basename } from "node:path";

export const MAX_TITLE_CHARS = 120;
const FENCE = /^(`{3,}|~{3,})/;
const H1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** `Key: value` with a short, unquoted key. Longer or quoted "keys" are sentences with a colon. */
const KEY_VALUE = /^([^:"“”]{1,40}):\s+(.+)$/;
const MIN_WORDS = 2;
const MIN_VALUE_WORDS = 3;

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Cut at the last word boundary at or before `max`; never leaves trailing whitespace. */
function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return (at > 0 ? head.slice(0, at) : s.slice(0, max)).trimEnd();
}

/** Strip inline markdown and list/quote/heading prefixes from one line. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^(?:>\s*)+/, "") // blockquote
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "") // list marker
    .replace(/^#{1,6}\s+/, "") // heading hashes
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link → text
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[^\w*])(\*|_)([^*_\s][^*_]*?)\2(?=[^\w*]|$)/g, "$1$3") // italic
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:$/, "")
    .trim();
}

/**
 * One line → a usable title, or null to skip it and try the next line.
 * Skips structure (tables, rules, fences, comments, image-only lines) and lines that clean
 * to fewer than two words. A short `Key: value` line yields its value when the value is a
 * real phrase (three or more words) and is skipped otherwise, so `Project: Nexus` gives way
 * to the `Session: …` line under it.
 */
export function cleanTitleLine(raw: string): string | null {
  const line = raw.trim();
  if (line.length === 0) return null;
  if (line.startsWith("|")) return null; // table row or separator
  if (FENCE.test(line)) return null;
  if (/^(?:[-*_]\s*){3,}$/.test(line)) return null; // horizontal rule
  if (line.startsWith("<!--")) return null;
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(line)) return null; // image-only line

  let text = stripMarkdown(line);
  const kv = text.match(KEY_VALUE);
  if (kv && words(kv[1]) <= 3) {
    if (words(kv[2]) < MIN_VALUE_WORDS) return null;
    text = kv[2].trim();
  }
  if (words(text) < MIN_WORDS) return null;
  return cutAtWord(text, MAX_TITLE_CHARS);
}

export function deriveTitle(body: string, filePath: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");

  // First H1 outside a code fence.
  let fence: string | null = null;
  for (const line of lines) {
    const f = line.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = line.match(H1);
    if (h) {
      // An explicit heading is the author's title: strip markdown only, keep any
      // "Key: value" prefix the author chose.
      const cleaned = cutAtWord(stripMarkdown(h[1]), MAX_TITLE_CHARS);
      if (cleaned.length > 0) return cleaned;
    }
  }

  // First usable line outside a fence.
  fence = null;
  for (const line of lines) {
    const f = line.match(FENCE);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const cleaned = cleanTitleLine(line);
    if (cleaned) return cleaned;
  }

  return basename(filePath).replace(/\.md$/i, "");
}
