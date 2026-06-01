// Thin OpenAI-compatible clients for the local llama stack (loopback only).
// All calls fail soft: on timeout/unreachable they return null/empty so retrieval
// and indexing degrade gracefully rather than throwing.
import type { DaemonConfig } from "../config.js";

async function postJson(url: string, body: unknown, apiKey: string | undefined, timeoutMs: number): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[models] ${url} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[models] ${url} unreachable: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class ModelClient {
  /** Count of actual embedding HTTP calls — lets tests assert the dedup cache works. */
  embedCalls = 0;

  constructor(private cfg: DaemonConfig["models"]) {}

  /** Embed one or many strings -> 768-dim vectors (order preserved). null on failure. */
  async embed(input: string | string[], timeoutMs = 30_000): Promise<number[][] | null> {
    this.embedCalls++;
    const json = await postJson(
      `${this.cfg.embedUrl}/embeddings`,
      { model: this.cfg.embedModel, input },
      this.cfg.apiKey,
      timeoutMs,
    );
    if (!json?.data) return null;
    return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
  }

  /** Rerank documents against a query -> relevance scores aligned to input order. */
  async rerank(query: string, documents: string[], timeoutMs = 30_000): Promise<number[] | null> {
    if (documents.length === 0) return [];
    const json = await postJson(
      `${this.cfg.rerankUrl}/rerank`,
      { model: this.cfg.rerankModel, query, documents },
      this.cfg.apiKey,
      timeoutMs,
    );
    if (!json?.results) return null;
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of json.results as Array<{ index: number; relevance_score: number }>) {
      scores[r.index] = r.relevance_score;
    }
    return scores;
  }

  /** One-shot chat completion (HyDE / KG extraction). null on failure. */
  async complete(
    prompt: string,
    opts: { system?: string; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
  ): Promise<string | null> {
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ];
    const json = await postJson(
      `${this.cfg.genUrl}/chat/completions`,
      { messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 512 },
      this.cfg.apiKey,
      opts.timeoutMs ?? 60_000,
    );
    return json?.choices?.[0]?.message?.content ?? null;
  }

  /** Liveness check for a single endpoint via GET /models. */
  private async ping(baseUrl: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
        signal: ctrl.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ gen: boolean; embed: boolean; rerank: boolean }> {
    const [gen, embed, rerank] = await Promise.all([
      this.ping(this.cfg.genUrl),
      this.ping(this.cfg.embedUrl),
      this.ping(this.cfg.rerankUrl),
    ]);
    return { gen, embed, rerank };
  }
}
