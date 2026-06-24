import { test } from "node:test";
import assert from "node:assert/strict";
import { splitIntoChunks } from "../src/index/chunk.js";

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

test("splitIntoChunks defaults stay below the local embedder token limit with margin", () => {
  const text = Array.from({ length: 650 }, (_, i) => `archive-memory-token-${i}`).join(" ");

  const chunks = splitIntoChunks(text);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(wordCount(chunk) <= 180, `expected <= 180 words, got ${wordCount(chunk)}`);
  }
});

