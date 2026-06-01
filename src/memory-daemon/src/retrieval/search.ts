// Hybrid search: sentence-vec KNN + chunk-vec KNN + FTS5 prefix, fused by Reciprocal
// Rank Fusion (RRF). RRF is scale-free, so it combines cosine distance, FTS bm25 rank,
// and sentence/chunk lists without needing to normalize incomparable score units.
import type { AppContext } from "../context.js";
import { toVecBlob } from "../db/index.js";
import type { ScopeFilter } from "./types.js";

const RRF_K = 60;

function buildScope(filter: ScopeFilter): { clause: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  // namespace is applied whenever provided; scope:"isolated" is the caller asserting a
  // namespace boundary, scope:"cross" (default) simply omits namespace to search everything.
  if (filter.namespace) {
    clauses.push("m.namespace = ?");
    params.push(filter.namespace);
  }
  if (filter.project) {
    clauses.push("m.project = ?");
    params.push(filter.project);
  }
  if (filter.category) {
    clauses.push("m.category = ?");
    params.push(filter.category);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

interface SegHit {
  segId: number;
  memoryId: string;
  distance: number;
}

function knn(ctx: AppContext, target: "sentence" | "chunk", vec: number[], k: number, filter: ScopeFilter): SegHit[] {
  const vecTable = target === "sentence" ? "sentence_vec" : "chunk_vec";
  const rowTable = target === "sentence" ? "sentences" : "chunks";
  const scope = buildScope(filter);
  const sql = `
    WITH knn AS (
      SELECT rowid, distance FROM ${vecTable} WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    )
    SELECT r.id AS segId, r.memory_id AS memoryId, knn.distance AS distance
    FROM knn JOIN ${rowTable} r ON r.id = knn.rowid
    JOIN memories m ON m.id = r.memory_id
    WHERE m.deleted_at IS NULL${scope.clause}
    ORDER BY knn.distance`;
  return ctx.db.prepare(sql).all(toVecBlob(vec), k, ...scope.params) as SegHit[];
}

function ftsSearch(ctx: AppContext, query: string, k: number, filter: ScopeFilter): string[] {
  const terms = (query.toLowerCase().match(/[a-z0-9]{2,}/gi) ?? []).slice(0, 12);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `${t}*`).join(" OR ");
  const scope = buildScope(filter);
  const sql = `
    SELECT memories_fts.memory_id AS memoryId, rank
    FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id
    WHERE memories_fts MATCH ? AND m.deleted_at IS NULL${scope.clause}
    ORDER BY rank LIMIT ?`;
  try {
    return (ctx.db.prepare(sql).all(match, ...scope.params, k) as Array<{ memoryId: string }>).map((r) => r.memoryId);
  } catch {
    return []; // malformed FTS expression — skip this list rather than fail recall
  }
}

/** Collapse a segment-hit list to a deduped memory-ordering (first occurrence wins). */
function toMemoryOrder(hits: SegHit[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const h of hits) {
    if (!seen.has(h.memoryId)) {
      seen.add(h.memoryId);
      order.push(h.memoryId);
    }
  }
  return order;
}

export interface SearchResult {
  rankedMemories: string[];
  /** memoryId -> its KNN-matched sentence ids (best distance first), for rerank/trim. */
  candidateSentences: Map<string, number[]>;
  /** memoryId -> fused RRF score (blended with rerank for final ordering). */
  rrf: Map<string, number>;
}

/**
 * Run all enabled rankers and RRF-fuse them. `queryVecs` may contain the query embedding
 * and (optionally) the HyDE embedding; pass [] to run FTS-only (graceful degradation).
 */
export function hybridSearch(ctx: AppContext, query: string, queryVecs: number[][], filter: ScopeFilter): SearchResult {
  const { sentenceK, chunkK } = ctx.cfg.retrieval;
  const lists: string[][] = [];
  const candidateSentences = new Map<string, number[]>();

  for (const vec of queryVecs) {
    const sHits = knn(ctx, "sentence", vec, sentenceK, filter);
    lists.push(toMemoryOrder(sHits));
    for (const h of sHits) {
      const arr = candidateSentences.get(h.memoryId) ?? [];
      if (!arr.includes(h.segId)) arr.push(h.segId);
      candidateSentences.set(h.memoryId, arr);
    }
    lists.push(toMemoryOrder(knn(ctx, "chunk", vec, chunkK, filter)));
  }
  lists.push(ftsSearch(ctx, query, sentenceK, filter));

  const rrf = new Map<string, number>();
  for (const list of lists) {
    list.forEach((memoryId, idx) => {
      rrf.set(memoryId, (rrf.get(memoryId) ?? 0) + 1 / (RRF_K + idx));
    });
  }

  const rankedMemories = [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return { rankedMemories, candidateSentences, rrf };
}
