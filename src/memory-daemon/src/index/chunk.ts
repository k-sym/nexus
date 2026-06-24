// Text segmentation. Chunks = 180-word windows with 50-word overlap.
// Defense in depth: the local embedder is launched with --ubatch-size 1024 (see
// README local-model-stack), which comfortably fits 180-word chunks even when
// dense/technical text tokenizes above 1 token/word. 180 keeps a margin below the
// stock default ubatch of 512 too, so a misconfigured stack dead-letters loudly
// instead of silently truncating. Sentences = boundary split, >= 5 chars.

export interface ChunkOpts {
  wordsPerChunk?: number;
  overlap?: number;
}

export function splitIntoChunks(text: string, opts: ChunkOpts = {}): string[] {
  const wordsPerChunk = opts.wordsPerChunk ?? 180;
  const overlap = opts.overlap ?? 50;
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
