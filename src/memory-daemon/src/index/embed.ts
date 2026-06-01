// Embed text segments into a vec0 table, with FNV-1a dedup via embed_cache.
// Identical segments (across re-saves or across memories) are embedded once.
import type { AppContext } from "../context.js";
import { toVecBlob } from "../db/index.js";

export interface Segment {
  id: number; // rowid in chunks/sentences (becomes the vec0 rowid)
  text: string;
  seg_hash: string;
}

type VecTarget = "chunk" | "sentence";

/**
 * Ensure every segment has a vector in the target vec table. Returns the number of
 * segments that required a fresh embedding (cache misses). Throws if the embedder is
 * unreachable so the calling job retries.
 */
export async function embedSegments(ctx: AppContext, target: VecTarget, segments: Segment[]): Promise<number> {
  if (segments.length === 0) return 0;
  const vecTable = target === "chunk" ? "chunk_vec" : "sentence_vec";
  const rowTable = target === "chunk" ? "chunks" : "sentences";

  // 1) Resolve cache hits.
  const cache = new Map<string, Buffer>();
  const lookup = ctx.db.prepare("SELECT vec FROM embed_cache WHERE seg_hash = ?");
  for (const s of segments) {
    if (cache.has(s.seg_hash)) continue;
    const hit = lookup.get(s.seg_hash) as { vec: Buffer } | undefined;
    if (hit) cache.set(s.seg_hash, hit.vec);
  }

  // 2) Embed the unique misses in one batch.
  const missHashes = [...new Set(segments.filter((s) => !cache.has(s.seg_hash)).map((s) => s.seg_hash))];
  const missText = missHashes.map((h) => segments.find((s) => s.seg_hash === h)!.text);
  if (missHashes.length > 0) {
    const vectors = await ctx.models.embed(missText);
    if (!vectors) throw new Error("embedder unreachable");
    const now = new Date().toISOString();
    const insCache = ctx.db.prepare("INSERT OR IGNORE INTO embed_cache (seg_hash, vec, created_at) VALUES (?, ?, ?)");
    missHashes.forEach((h, i) => {
      const blob = toVecBlob(vectors[i]);
      cache.set(h, blob);
      insCache.run(h, blob, now);
    });
  }

  // 3) Write vectors at rowid = segment id; mark the row embedded.
  // vec0 has no INSERT OR REPLACE (UNIQUE on primary key), so delete-then-insert —
  // this also makes the write idempotent if a job retries after a partial failure.
  const delVec = ctx.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`);
  const insVec = ctx.db.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (?, ?)`);
  const markRow = ctx.db.prepare(`UPDATE ${rowTable} SET embedded = 1 WHERE id = ?`);
  const tx = ctx.db.transaction((segs: Segment[]) => {
    for (const s of segs) {
      // vec0 needs the rowid bound as an integer; a bound JS number is read as float
      // and rejected, so bind BigInt.
      delVec.run(BigInt(s.id));
      insVec.run(BigInt(s.id), cache.get(s.seg_hash)!);
      markRow.run(s.id);
    }
  });
  tx(segments);
  return missHashes.length;
}

/** Drop all vectors for a memory's chunks/sentences (used before re-indexing). */
export function dropVectors(ctx: AppContext, memoryId: string): void {
  for (const [rowTable, vecTable] of [
    ["chunks", "chunk_vec"],
    ["sentences", "sentence_vec"],
  ] as const) {
    const ids = ctx.db.prepare(`SELECT id FROM ${rowTable} WHERE memory_id = ?`).all(memoryId) as Array<{ id: number }>;
    const del = ctx.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`);
    for (const r of ids) del.run(BigInt(r.id));
  }
}
