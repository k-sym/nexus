// Final assembly: surgical sentence trim + small-to-big parent-chunk fetch + token-budget cap.
//
// Ordering blends RRF fusion (which carries the HyDE/semantic + lexical signal) with the 4003
// cross-encoder rerank, so a strong fusion hit isn't discarded by a weak rerank score on an
// indirectly-phrased query. The cross-encoder threshold is a *noise floor* (default 0.05) that
// trims EXTRA sentences only — each returned memory always keeps its single best sentence.
import type { AppContext } from "../context.js";
import type { MatchedSentence, RecallItem, Triple } from "./types.js";

const HISTORY_SEEKING = /\b(what did we|what have we|remind me|what was|recap|summar|catch me up|last time)\b/i;
const MAX_SENTENCES = 3;
const RRF_WEIGHT = 0.5;
const RERANK_WEIGHT = 0.5;
const FACT_BOOST = 0.1; // small nudge for memories whose KG facts match the query
const estTokens = (s: string) => Math.ceil(s.length / 4);

interface MemoryRow {
  id: string;
  title: string | null;
  namespace: string;
  project: string | null;
  category: string | null;
  source: string;
  body: string;
  file_path: string;
  created_at: string;
  updated_at: string;
}
interface SentenceRow {
  id: number;
  text: string;
  chunk_id: number;
  score: number;
}

export interface AssembleInput {
  query: string;
  rankedMemories: string[];
  candidateSentences: Map<string, number[]>;
  rrf: Map<string, number>;
  sentenceScores: Map<number, number> | null; // null => reranker unavailable
  factsByMemory?: Map<string, Triple[]>; // KG triples matching the query, per memory
}

export function assemble(ctx: AppContext, input: AssembleInput): RecallItem[] {
  const { sentenceThreshold, tokenBudget } = ctx.cfg.retrieval;
  const historySeeking = HISTORY_SEEKING.test(input.query);
  const maxRrf = Math.max(...input.rrf.values(), 1e-9);

  const getMem = ctx.db.prepare(
    "SELECT id, title, namespace, project, category, source, body, file_path, created_at, updated_at FROM memories WHERE id = ? AND deleted_at IS NULL",
  );
  const getSentences = ctx.db.prepare("SELECT id, text, chunk_id FROM sentences WHERE id IN (SELECT value FROM json_each(?))");
  const firstSentences = ctx.db.prepare("SELECT id, text, chunk_id FROM sentences WHERE memory_id = ? ORDER BY ord LIMIT 3");
  const getChunk = ctx.db.prepare("SELECT text FROM chunks WHERE id = ?");

  interface Built {
    item: RecallItem;
    order: number; // blended ranking score
    cost: number;
  }
  const built: Built[] = [];

  for (const memoryId of input.rankedMemories) {
    const mem = getMem.get(memoryId) as MemoryRow | undefined;
    if (!mem) continue;

    const candIds = input.candidateSentences.get(memoryId) ?? [];
    const rows = (getSentences.all(JSON.stringify(candIds)) as Array<{ id: number; text: string; chunk_id: number }>).map(
      (r) => ({ ...r, score: input.sentenceScores?.get(r.id) ?? 0 }),
    );

    let picked: SentenceRow[];
    if (rows.length > 0) {
      const ranked = rows.sort((a, b) => b.score - a.score);
      // Always keep the best sentence; add extras only if they clear the noise floor.
      picked = [ranked[0], ...ranked.slice(1).filter((r) => r.score >= sentenceThreshold)].slice(0, MAX_SENTENCES);
    } else if (historySeeking || candIds.length === 0) {
      // Opening-sentences fallback for history-seeking queries or FTS-only memories.
      picked = (firstSentences.all(memoryId) as Array<{ id: number; text: string; chunk_id: number }>).map((r) => ({ ...r, score: 0 }));
    } else {
      continue;
    }
    if (picked.length === 0) continue;

    const chunkIds = [...new Set(picked.map((p) => p.chunk_id))];
    const parentChunks = chunkIds
      .map((cid) => (getChunk.get(cid) as { text: string } | undefined)?.text)
      .filter((t): t is string => Boolean(t));
    const sentences: MatchedSentence[] = picked.map((p) => ({ id: p.id, text: p.text, score: p.score, chunkId: p.chunk_id }));

    const facts = input.factsByMemory?.get(memoryId);
    const bestRerank = Math.max(...sentences.map((s) => s.score), 0);
    const rrfNorm = (input.rrf.get(memoryId) ?? 0) / maxRrf;
    const base = input.sentenceScores ? RRF_WEIGHT * rrfNorm + RERANK_WEIGHT * bestRerank : rrfNorm;
    const order = base + (facts && facts.length > 0 ? FACT_BOOST : 0);

    const item: RecallItem = {
      id: mem.id,
      title: mem.title,
      namespace: mem.namespace,
      project: mem.project,
      category: mem.category,
      source: mem.source,
      score: bestRerank,
      sentences,
      parentChunks,
      body: mem.body,
      created_at: mem.created_at,
      updated_at: mem.updated_at,
      filePath: mem.file_path,
      ...(facts && facts.length > 0 ? { facts } : {}),
    };
    built.push({ item, order, cost: estTokens(parentChunks.join(" ")) + estTokens(sentences.map((s) => s.text).join(" ")) });
  }

  built.sort((a, b) => b.order - a.order);

  const items: RecallItem[] = [];
  let spent = 0;
  for (const b of built) {
    if (spent + b.cost > tokenBudget && items.length > 0) break; // always return at least one
    spent += b.cost;
    items.push(b.item);
  }
  return items;
}
