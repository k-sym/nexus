// Recall orchestrator: HyDE -> embed -> hybrid fusion -> rerank -> assemble.
// Degrades gracefully: no embedder => FTS-only; no reranker => fusion order + opening sentences.
import type { AppContext } from "../context.js";
import type { RecallItem, RecallResponse, ScopeFilter } from "./types.js";
import { generateHyde } from "./hyde.js";
import { hybridSearch } from "./search.js";
import { rerankSentences } from "./rerank.js";
import { assemble } from "./assemble.js";
import { factsForQuery } from "../kg/fuse.js";

const TOP_MEMORIES_FOR_RERANK = 10;

export async function recall(
  ctx: AppContext,
  query: string,
  filter: ScopeFilter = {},
  opts: { limit?: number } = {},
): Promise<RecallResponse> {
  let degraded = false;

  const hyde = await generateHyde(ctx, query);
  const texts = hyde ? [query, hyde] : [query];
  let embedded: number[][] | null = null;
  try {
    embedded = await ctx.models.embed(texts);
  } catch (err) {
    // Embedder down or misconfigured — degrade to FTS-only rather than failing recall.
    console.warn(`[recall] embed failed, degrading to FTS-only: ${(err as Error).message}`);
  }
  const queryVecs = embedded ?? [];
  if (!embedded) degraded = true;

  const search = hybridSearch(ctx, query, queryVecs, filter);

  // Rerank the candidate sentences of the top fused memories.
  const rerankIds: number[] = [];
  for (const memoryId of search.rankedMemories.slice(0, TOP_MEMORIES_FOR_RERANK)) {
    rerankIds.push(...(search.candidateSentences.get(memoryId) ?? []));
  }
  const sentenceScores = await rerankSentences(ctx, query, rerankIds.slice(0, ctx.cfg.retrieval.rerankK));
  if (sentenceScores === null) degraded = true;

  const qFacts = factsForQuery(ctx, query, filter);
  let items = assemble(ctx, {
    query,
    rankedMemories: search.rankedMemories,
    candidateSentences: search.candidateSentences,
    rrf: search.rrf,
    sentenceScores,
    factsByMemory: qFacts.byMemory,
  });
  if (opts.limit) items = items.slice(0, opts.limit);

  return { query, hyde, degraded, items };
}

/** Render a recall response as an injection-ready context block with citations. */
export function formatContext(res: RecallResponse): string {
  if (res.items.length === 0) return "";
  const blocks = res.items.map((it: RecallItem) => {
    const head = `### ${it.title ?? it.id} [${it.namespace}${it.project ? "/" + it.project : ""}]`;
    const body = it.sentences.map((s) => `- ${s.text}`).join("\n");
    const facts = it.facts?.length ? `\nfacts: ${it.facts.map((f) => `(${f.subject} ${f.relation} ${f.object})`).join("; ")}` : "";
    return `${head}\n${body}${facts}`;
  });
  return blocks.join("\n\n");
}
