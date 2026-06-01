// Text segmentation. Chunks = 300-word windows with 80-word overlap (ArcRift params).
// Sentences = boundary split, kept only if >= 5 chars (drops noise fragments).

export interface ChunkOpts {
  wordsPerChunk?: number;
  overlap?: number;
}

export function splitIntoChunks(text: string, opts: ChunkOpts = {}): string[] {
  const wordsPerChunk = opts.wordsPerChunk ?? 300;
  const overlap = opts.overlap ?? 80;
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
