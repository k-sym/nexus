/**
 * Embeddings & rerank client for the local OpenAI-compatible server (omlx).
 *
 * Both are optional: when models.local.embedding_model / rerank_model are blank
 * the memory system falls back to lexical TF-IDF search. We embed queries and
 * documents symmetrically (no Qwen3 query-instruction prefix) — the reranker is
 * the precision stage, so the embedding pass only needs decent recall.
 */
import { loadConfig, resolveEnvVars } from '../config';

function localServer(): { baseUrl: string; apiKey: string } {
  const cfg = loadConfig();
  return {
    baseUrl: cfg.models.local.base_url.replace(/\/$/, ''),
    apiKey: resolveEnvVars(cfg.models.local.api_key || ''),
  };
}

function headers(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export function embeddingModel(): string {
  return loadConfig().models.local.embedding_model || '';
}

export function rerankModel(): string {
  return loadConfig().models.local.rerank_model || '';
}

export function embeddingsEnabled(): boolean {
  return !!embeddingModel();
}

/** Embed one or more texts. Returns one vector per input, in order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = embeddingModel();
  if (!model) throw new Error('No embedding model configured');
  const { baseUrl, apiKey } = localServer();

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);

  const data = await res.json() as { data: { index: number; embedding: number[] }[] };
  // Sort by index defensively, then return just the vectors.
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

/** Rerank documents against a query. Returns {index, score} sorted best-first. */
export async function rerank(query: string, documents: string[], topN: number): Promise<{ index: number; score: number }[]> {
  const model = rerankModel();
  if (!model) throw new Error('No rerank model configured');
  const { baseUrl, apiKey } = localServer();

  const res = await fetch(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, query, documents, top_n: topN }),
  });
  if (!res.ok) throw new Error(`rerank ${res.status}: ${await res.text()}`);

  const data = await res.json() as { results: { index: number; relevance_score: number }[] };
  return data.results.map(r => ({ index: r.index, score: r.relevance_score }));
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
