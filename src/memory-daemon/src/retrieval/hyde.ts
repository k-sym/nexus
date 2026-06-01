// HyDE — Hypothetical Document Embedding. Draft a short hypothetical answer to the query
// and embed it alongside the raw query; lifts recall for rephrased/indirect questions.
import type { AppContext } from "../context.js";

const SYSTEM =
  "You write a brief, plausible answer to the user's question as if recalling a note. " +
  "2-3 sentences, factual tone, no preamble. If you don't know specifics, write a generic " +
  "answer using likely terminology.";

export async function generateHyde(ctx: AppContext, query: string): Promise<string | null> {
  if (!ctx.cfg.retrieval.hyde) return null;
  const out = await ctx.models.complete(query, { system: SYSTEM, temperature: 0.3, maxTokens: 128, timeoutMs: 20_000 });
  const text = out?.trim();
  return text && text.length > 0 ? text : null;
}
