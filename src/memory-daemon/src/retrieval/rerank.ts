// Cross-encoder rerank via the 4003 reranker. Returns a sentenceId -> relevance_score map,
// or null if the reranker is unavailable (caller degrades to fusion order).
import type { AppContext } from "../context.js";

export async function rerankSentences(
  ctx: AppContext,
  query: string,
  sentenceIds: number[],
): Promise<Map<number, number> | null> {
  if (sentenceIds.length === 0) return new Map();
  const placeholders = sentenceIds.map(() => "?").join(",");
  const rows = ctx.db
    .prepare(`SELECT id, text FROM sentences WHERE id IN (${placeholders})`)
    .all(...sentenceIds) as Array<{ id: number; text: string }>;

  let scores: number[];
  try {
    scores = await ctx.models.rerank(query, rows.map((r) => r.text));
  } catch (err) {
    // Reranker unavailable — caller degrades to fusion order.
    console.warn(`[rerank] failed, degrading to fusion order: ${(err as Error).message}`);
    return null;
  }

  const out = new Map<number, number>();
  rows.forEach((r, i) => out.set(r.id, scores[i] ?? 0));
  return out;
}
