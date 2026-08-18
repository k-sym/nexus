// Model clients: cloud-first via OpenRouter (when configured) with the local
// llama stack as fallback; local-only when no OpenRouter config is present.
// Embeddings are always local — the sqlite-vec index is bound to the local
// embedder's vector space (see config.ts).
// Calls THROW a ModelError on failure, distinguishing a transport failure
// (connection refused / DNS / timeout) from an HTTP error status (4xx/5xx),
// and carry the status code + a body snippet so the real cause is visible in
// jobs.last_error. Retrieval callers catch this to degrade gracefully; indexing
// jobs let it propagate so a misconfigured stack fails loudly instead of
// silently dead-lettering with a wrong "unreachable" message.
import type { DaemonConfig, GenTask } from "../config.js";

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

/** Latching circuit breaker for the cloud tier: after `threshold` consecutive
 *  failures, skip the cloud provider for `cooldownMs` so an offline host pays
 *  the network-timeout tax once, not on every call. A success closes it. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 120_000,
  ) {}

  canAttempt(): boolean {
    return Date.now() >= this.openUntil;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      this.failures = 0; // half-open after cooldown: one probe re-opens or closes
      console.warn(`[models] cloud circuit OPEN for ${this.cooldownMs / 1000}s`);
    }
  }

  get state(): "closed" | "open" {
    return this.canAttempt() ? "closed" : "open";
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

/** Extract the score array from an LLM rerank reply. Lenient about wrapping
 *  (markdown fences, stray prose) but strict about the payload: exactly `expected`
 *  finite numbers, clamped to [0,1]. Exported for tests. */
export function parseScores(content: string, expected: number, url: string): number[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new ModelError(`${url} rerank reply had no JSON array`, "config", url, undefined, content.slice(0, 300));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ModelError(`${url} rerank reply was not valid JSON`, "config", url, undefined, content.slice(0, 300));
  }
  if (!Array.isArray(parsed) || parsed.length !== expected || !parsed.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new ModelError(
      `${url} rerank reply shape mismatch (wanted ${expected} numbers)`,
      "config",
      url,
      undefined,
      content.slice(0, 300),
    );
  }
  return (parsed as number[]).map((n) => Math.min(1, Math.max(0, n)));
}

export class ModelClient {
  /** Count of actual embedding HTTP calls — lets tests assert the dedup cache works. */
  embedCalls = 0;
  /** One breaker for the whole cloud tier: gen and rerank share the same host,
   *  so a dead network trips both at once rather than paying two timeout taxes. */
  readonly cloudBreaker = new CircuitBreaker();

  constructor(private cfg: DaemonConfig["models"]) {}

  private get cloudFirst(): boolean {
    return Boolean(this.cfg.openrouter) && this.cfg.prefer === "cloud";
  }

  /** Embed one or many strings -> 768-dim vectors (order preserved). Throws ModelError on failure. */
  async embed(input: string | string[], timeoutMs = 30_000): Promise<number[][]> {
    this.embedCalls++;
    const url = `${this.cfg.embedUrl}/embeddings`;
    const json = await postJson(url, { model: this.cfg.embedModel, input }, this.cfg.apiKey, timeoutMs);
    const data = json?.data as Array<{ embedding: number[] }> | undefined;
    if (!data) throw new ModelError(`${url} returned no embedding data`, "http", url, undefined, JSON.stringify(json).slice(0, 300));
    return data.map((d) => d.embedding);
  }

  /** Rerank documents against a query -> relevance scores aligned to input order.
   *  Cloud-first: LLM listwise scoring via OpenRouter (there is no cloud /rerank
   *  endpoint), local cross-encoder as fallback. Throws ModelError on failure. */
  async rerank(query: string, documents: string[], timeoutMs = 30_000): Promise<number[]> {
    if (documents.length === 0) return [];
    const or = this.cfg.openrouter;
    if (or && this.cloudFirst && this.cloudBreaker.canAttempt()) {
      const started = Date.now();
      try {
        const scores = await this.rerankViaLLM(query, documents, timeoutMs);
        this.cloudBreaker.recordSuccess();
        return scores;
      } catch (err) {
        this.cloudBreaker.recordFailure();
        const remaining = timeoutMs - (Date.now() - started);
        // A fast cloud failure leaves budget for a local attempt; a cloud timeout
        // consumed it — rethrow and let the caller degrade to fusion order.
        if (remaining < timeoutMs * 0.5) throw err;
        console.warn(`[models] cloud rerank failed, trying local: ${(err as Error).message}`);
        return await this.localRerank(query, documents, remaining);
      }
    }
    return await this.localRerank(query, documents, timeoutMs);
  }

  private async localRerank(query: string, documents: string[], timeoutMs: number): Promise<number[]> {
    const url = `${this.cfg.rerankUrl}/rerank`;
    const json = await postJson(url, { model: this.cfg.rerankModel, query, documents }, this.cfg.apiKey, timeoutMs);
    const results = json?.results as Array<{ index: number; relevance_score: number }> | undefined;
    if (!results) throw new ModelError(`${url} returned no rerank results`, "http", url, undefined, JSON.stringify(json).slice(0, 300));
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of results) scores[r.index] = r.relevance_score;
    return scores;
  }

  /** LLM listwise rerank: one chat call scores every candidate (RankGPT-style).
   *  Documents are truncated — vault sentences are short and the ordering signal
   *  lives in the first clause; the cap bounds cost under the cue-loop cadence. */
  private async rerankViaLLM(query: string, documents: string[], timeoutMs: number): Promise<number[]> {
    const or = this.cfg.openrouter!;
    const url = `${or.baseUrl}/chat/completions`;
    const docs = documents.map((d, i) => `${i + 1}. ${d.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
    const json = await postJson(
      url,
      {
        model: or.rerankModel,
        temperature: 0,
        max_tokens: 32 + 8 * documents.length,
        messages: [
          {
            role: "system",
            content:
              "You score how relevant each document is to a query for memory retrieval. " +
              `Reply with ONLY a JSON array of ${documents.length} numbers between 0 and 1, ` +
              "one score per document in the given order. No prose, no keys, no markdown fence.",
          },
          { role: "user", content: `Query: ${query}\n\nDocuments:\n${docs}` },
        ],
      },
      or.apiKey,
      timeoutMs,
    );
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    return parseScores(content, documents.length, url);
  }

  /** One-shot chat completion (HyDE / KG extraction / operations routes).
   *  Cloud-first via OpenRouter with a per-task model, local gen as fallback. */
  async complete(
    prompt: string,
    opts: { system?: string; temperature?: number; maxTokens?: number; timeoutMs?: number; task?: GenTask } = {},
  ): Promise<string> {
    const or = this.cfg.openrouter;
    if (or && this.cloudFirst && this.cloudBreaker.canAttempt()) {
      const budget = opts.timeoutMs ?? 60_000;
      const started = Date.now();
      try {
        const model = (opts.task && or.tasks[opts.task]) || or.defaultModel;
        const out = await this.chatCompletion(`${or.baseUrl}/chat/completions`, model, prompt, opts, or.apiKey);
        this.cloudBreaker.recordSuccess();
        return out;
      } catch (err) {
        this.cloudBreaker.recordFailure();
        const remaining = budget - (Date.now() - started);
        if (remaining < budget * 0.5) throw err;
        console.warn(`[models] cloud gen failed, trying local: ${(err as Error).message}`);
        return await this.chatCompletion(
          `${this.cfg.genUrl}/chat/completions`,
          undefined,
          prompt,
          { ...opts, timeoutMs: remaining },
          this.cfg.apiKey,
        );
      }
    }
    return await this.chatCompletion(`${this.cfg.genUrl}/chat/completions`, undefined, prompt, opts, this.cfg.apiKey);
  }

  private async chatCompletion(
    url: string,
    model: string | undefined,
    prompt: string,
    opts: { system?: string; temperature?: number; maxTokens?: number; timeoutMs?: number },
    apiKey: string | undefined,
  ): Promise<string> {
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ];
    const json = await postJson(
      url,
      // The local llama-server serves one model and ignores the field; OpenRouter requires it.
      { ...(model ? { model } : {}), messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 512 },
      apiKey,
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

  async health(): Promise<{
    gen: boolean;
    embed: boolean;
    rerank: boolean;
    cloud?: { provider: "openrouter"; prefer: "cloud" | "local"; breaker: "closed" | "open" };
  }> {
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
    return {
      gen,
      embed,
      rerank,
      ...(this.cfg.openrouter
        ? { cloud: { provider: "openrouter" as const, prefer: this.cfg.prefer, breaker: this.cloudBreaker.state } }
        : {}),
    };
  }
}
