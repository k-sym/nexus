// Indexing orchestration.
//  - buildSegments: synchronous + local (FTS + chunk/sentence rows). Runs in ingest so a
//    memory is keyword-searchable immediately.
//  - embedPending: embeds not-yet-embedded rows for a target. Chunks are embedded inline
//    in ingest when the embedder is up (instant vectors); the deep_index job backfills
//    anything that failed and embeds sentences. Embedder downtime degrades gracefully.
import type { AppContext } from "../context.js";
import { splitIntoChunks, splitIntoSentences } from "./chunk.js";
import { fnv1a } from "../sync/hash.js";
import { upsertFts } from "./fts.js";
import { dropVectors, embedSegments, type Segment } from "./embed.js";

export function buildSegments(ctx: AppContext, memoryId: string, title: string, body: string): void {
  const tx = ctx.db.transaction(() => {
    dropVectors(ctx, memoryId);
    ctx.db.prepare("DELETE FROM sentences WHERE memory_id = ?").run(memoryId);
    ctx.db.prepare("DELETE FROM chunks WHERE memory_id = ?").run(memoryId);
    upsertFts(ctx.db, memoryId, title, body);

    const insChunk = ctx.db.prepare(
      "INSERT INTO chunks (memory_id, ord, text, seg_hash, embedded) VALUES (?, ?, ?, ?, 0)",
    );
    const insSentence = ctx.db.prepare(
      "INSERT INTO sentences (memory_id, chunk_id, ord, text, seg_hash, embedded) VALUES (?, ?, ?, ?, ?, 0)",
    );

    const seenSentence = new Set<string>(); // dedupe sentences across overlapping chunks
    let sOrd = 0;
    splitIntoChunks(body).forEach((text, ord) => {
      const chunkId = Number(insChunk.run(memoryId, ord, text, fnv1a(text)).lastInsertRowid);
      for (const sent of splitIntoSentences(text)) {
        const h = fnv1a(sent);
        if (seenSentence.has(h)) continue;
        seenSentence.add(h);
        insSentence.run(memoryId, chunkId, sOrd++, sent, h);
      }
    });
  });
  tx();
}

/** Embed rows of `target` (chunk|sentence) for a memory that aren't embedded yet. */
export async function embedPending(ctx: AppContext, memoryId: string, target: "chunk" | "sentence"): Promise<number> {
  const table = target === "chunk" ? "chunks" : "sentences";
  const rows = ctx.db
    .prepare(`SELECT id, text, seg_hash FROM ${table} WHERE memory_id = ? AND embedded = 0`)
    .all(memoryId) as Segment[];
  return embedSegments(ctx, target, rows);
}
