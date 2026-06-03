// Thin OpenAI-compatible clients for the local llama stack (loopback only).
// Calls THROW a ModelError on failure, distinguishing a transport failure
// (connection refused / DNS / timeout) from an HTTP error status (4xx/5xx),
// and carry the status code + a body snippet so the real cause is visible in
// jobs.last_error. Retrieval callers catch this to degrade gracefully; indexing
// jobs let it propagate so a misconfigured stack fails loudly instead of
// silently dead-lettering with a wrong "unreachable" message.
import type { DaemonConfig } from "../config.js";

/** A model-stack call failed. `kind` separates "the server is down" (transport)
 *  from "the server answered with an error" (http — e.g. a 501 from a llama-server
 *  launched without --embedding) from "the server is misconfigured" (config — e.g.
 *  a reasoning model that returned only hidden reasoning). `retryable` is false for
 *  config errors: retrying won't help until the server is reconfigured, so the job
 *  should dead-letter immediately rather than churn through its retry budget. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: "transport" | "http" | "config",
    readonly url: string,
    readonly status?: number,
    readonly bodySnippet?: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

async function postJson(url: string, body: unknown, apiKey: string | undefined, timeoutMs: number): Promise<any> {
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
      const snippet = (await res.text().catch(() => "")).trim().replace(/\s+/g, " ").slice(0, 300);
      console.warn(`[models] ${url} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`);
      throw new ModelError(
        `${url} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
        "http",
        url,
        res.status,
        snippet || undefined,
      );
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ModelError) throw err;
    const e = err as Error;
    const reason = e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message;
    console.warn(`[models] ${url} unreachable: ${reason}`);
    throw new ModelError(`${url} unreachable (${reason})`, "transport", url);
  } finally {
    clearTimeout(timer);
  }
}

export class ModelClient {
  /** Count of actual embedding HTTP calls — lets tests assert the dedup cache works. */
  embedCalls = 0;

  constructor(private cfg: DaemonConfig["models"]) {}

  /** Embed one or many strings -> 768-dim vectors (order preserved). Throws ModelError on failure. */
  async embed(input: string | string[], timeoutMs = 30_000): Promise<number[][]> {
    this.embedCalls++;
    const url = `${this.cfg.embedUrl}/embeddings`;
    const json = await postJson(url, { model: this.cfg.embedModel, input }, this.cfg.apiKey, timeoutMs);
    const data = json?.data as Array<{ embedding: number[] }> | undefined;
    if (!data) throw new ModelError(`${url} returned no embedding data`, "http", url, undefined, JSON.stringify(json).slice(0, 300));
    return data.map((d) => d.embedding);
  }

  /** Rerank documents against a query -> relevance scores aligned to input order. Throws ModelError on failure. */
  async rerank(query: string, documents: string[], timeoutMs = 30_000): Promise<number[]> {
    if (documents.length === 0) return [];
    const url = `${this.cfg.rerankUrl}/rerank`;
    const json = await postJson(url, { model: this.cfg.rerankModel, query, documents }, this.cfg.apiKey, timeoutMs);
    const results = json?.results as Array<{ index: number; relevance_score: number }> | undefined;
    if (!results) throw new ModelError(`${url} returned no rerank results`, "http", url, undefined, JSON.stringify(json).slice(0, 300));
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of results) scores[r.index] = r.relevance_score;
    return scores;
  }

  /** One-shot chat completion (HyDE / KG extraction). Throws ModelError on failure. */
  async complete(
    prompt: string,
    opts: { system?: string; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
  ): Promise<string> {
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ];
    const url = `${this.cfg.genUrl}/chat/completions`;
    const json = await postJson(
      url,
      { messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 512 },
      this.cfg.apiKey,
      opts.timeoutMs ?? 60_000,
    );
    const choice = json?.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    // A reasoning/thinking model launched without thinking disabled can spend its
    // whole token budget on hidden reasoning, returning empty content (the text
    // lands in reasoning_content) with finish_reason "length". Fail loudly and
    // non-retryably instead of letting callers choke on empty output.
    if (!content.trim()) {
      const reasoning = choice?.message?.reasoning_content;
      const finish = choice?.finish_reason;
      if (reasoning || finish === "length") {
        throw new ModelError(
          `${url} returned only reasoning (finish_reason=${finish ?? "?"}, empty content) — ` +
            `disable thinking on the gen server (e.g. --reasoning off) or use a non-reasoning model`,
          "config",
          url,
          undefined,
          typeof reasoning === "string" ? reasoning.slice(0, 200) : undefined,
          false,
        );
      }
    }
    return content;
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

  /** Capability probe: actually exercise an endpoint with a tiny payload so a
   *  reachable-but-misconfigured server (e.g. 501 Not Implemented) reads as
   *  unhealthy. Uses postJson directly to avoid perturbing embedCalls. */
  private async probe(url: string, body: unknown, ok: (json: any) => boolean): Promise<boolean> {
    try {
      return ok(await postJson(url, body, this.cfg.apiKey, 3000));
    } catch {
      return false;
    }
  }

  async health(): Promise<{ gen: boolean; embed: boolean; rerank: boolean }> {
    const [gen, embed, rerank] = await Promise.all([
      this.ping(this.cfg.genUrl), // gen capability is exercised by extract_kg (#27); a liveness ping suffices here
      this.probe(
        `${this.cfg.embedUrl}/embeddings`,
        { model: this.cfg.embedModel, input: "ok" },
        (j) => Array.isArray(j?.data) && j.data.length > 0,
      ),
      this.probe(
        `${this.cfg.rerankUrl}/rerank`,
        { model: this.cfg.rerankModel, query: "ok", documents: ["ok"] },
        (j) => Array.isArray(j?.results),
      ),
    ]);
    return { gen, embed, rerank };
  }
}
