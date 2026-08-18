// Cloud-first provider chain: OpenRouter primary, local llama fallback, circuit
// breaker latching, and the shared /rerank wire shape. Exercises the real
// ModelClient HTTP path by stubbing globalThis.fetch.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DaemonConfig } from "../src/config.js";
import { ModelClient } from "../src/models/client.js";

const OR_URL = "https://openrouter.example/api/v1";
const LOCAL_GEN = "http://127.0.0.1:1/v1";
const LOCAL_RERANK = "http://127.0.0.1:2/v1";

function modelsCfg(overrides: Partial<DaemonConfig["models"]> = {}): DaemonConfig["models"] {
  return {
    genUrl: LOCAL_GEN,
    embedUrl: "http://127.0.0.1:3/v1",
    embedModel: "test-embed",
    rerankUrl: LOCAL_RERANK,
    rerankModel: "test-rerank",
    prefer: "cloud",
    openrouter: {
      apiKey: "or-key",
      baseUrl: OR_URL,
      tasks: { next_message: "fast-model", kg_extraction: "quality-model" },
      defaultModel: "default-model",
      rerankModel: "scorer-model",
      providerOnly: ["Anthropic"],
    },
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  body: any;
  auth?: string;
}

/** Stub fetch with a per-URL-prefix handler; records every call. */
function stubFetch(handler: (url: string, body: any) => { status?: number; json?: unknown } | "hang" | "refuse") {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, auth: init?.headers?.authorization });
    const res = handler(url, body);
    if (res === "refuse") throw new TypeError("fetch failed: connection refused");
    if (res === "hang") {
      // Resolve only via abort, mimicking a timeout.
      return await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return {
      ok: (res.status ?? 200) < 400,
      status: res.status ?? 200,
      json: async () => res.json,
      text: async () => JSON.stringify(res.json),
    };
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const chat = (content: string) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });

test("complete: cloud-first uses the per-task OpenRouter model and key", async () => {
  const calls = stubFetch(() => ({ json: chat("cloud says hi") }));
  const client = new ModelClient(modelsCfg());
  const out = await client.complete("hello", { task: "next_message" });
  assert.equal(out, "cloud says hi");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(OR_URL));
  assert.equal(calls[0].body.model, "fast-model");
  assert.equal(calls[0].auth, "Bearer or-key");
  assert.deepEqual(calls[0].body.provider, { only: ["Anthropic"] }); // provider pin on chat
});

test("complete: unmapped task falls back to defaultModel; prefer=local skips cloud", async () => {
  let calls = stubFetch(() => ({ json: chat("x") }));
  await new ModelClient(modelsCfg()).complete("hello", { task: "hyde" });
  assert.equal(calls[0].body.model, "default-model");

  calls = stubFetch(() => ({ json: chat("local") }));
  const out = await new ModelClient(modelsCfg({ prefer: "local" })).complete("hello", { task: "hyde" });
  assert.equal(out, "local");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(LOCAL_GEN));
  assert.equal(calls[0].body.model, undefined); // local llama-server serves one model
});

test("complete: fast cloud failure falls back to local within the budget", async () => {
  const calls = stubFetch((url) => (url.startsWith(OR_URL) ? "refuse" : { json: chat("local answer") }));
  const client = new ModelClient(modelsCfg());
  const out = await client.complete("hello", { task: "kg_extraction", timeoutMs: 5000 });
  assert.equal(out, "local answer");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.startsWith(LOCAL_GEN));
  assert.equal(calls[1].body.provider, undefined); // pin is OpenRouter-only, never sent to llama
});

test("circuit breaker: opens after 3 failures and skips cloud entirely", async () => {
  const calls = stubFetch((url) => (url.startsWith(OR_URL) ? "refuse" : { json: chat("local") }));
  const client = new ModelClient(modelsCfg());
  for (let i = 0; i < 3; i++) await client.complete("q", { timeoutMs: 5000 });
  assert.equal(client.cloudBreaker.state, "open");
  const before = calls.length;
  await client.complete("q", { timeoutMs: 5000 });
  const newCalls = calls.slice(before);
  assert.equal(newCalls.length, 1, "breaker open: straight to local, no cloud attempt");
  assert.ok(newCalls[0].url.startsWith(LOCAL_GEN));
});

test("rerank: cloud /rerank endpoint serves scores; breaker records success", async () => {
  const calls = stubFetch(() => ({
    json: { results: [{ index: 0, relevance_score: 0.72 }, { index: 2, relevance_score: 0.4 }, { index: 1, relevance_score: 0.1 }] },
  }));
  const client = new ModelClient(modelsCfg());
  const scores = await client.rerank("query", ["a", "b", "c"], 2000);
  assert.deepEqual(scores, [0.72, 0.1, 0.4]); // results come back ranked; scores realign to input order
  assert.equal(calls[0].url, `${OR_URL}/rerank`);
  assert.equal(calls[0].body.model, "scorer-model");
  assert.equal(calls[0].auth, "Bearer or-key");
  assert.equal(calls[0].body.provider, undefined); // chat pin must not leak into /rerank
  assert.equal(client.cloudBreaker.state, "closed");
});

test("rerank: cloud failure falls back to the local cross-encoder", async () => {
  const calls = stubFetch((url) =>
    url.startsWith(OR_URL)
      ? { status: 502, json: { error: "upstream sad" } }
      : { json: { results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.3 }] } },
  );
  const client = new ModelClient(modelsCfg());
  const scores = await client.rerank("query", ["a", "b"], 5000);
  assert.deepEqual(scores, [0.7, 0.3]);
  assert.equal(calls[1].url, `${LOCAL_RERANK}/rerank`);
});

test("rerank: no openrouter config behaves exactly as before (local only)", async () => {
  const calls = stubFetch(() => ({ json: { results: [{ index: 0, relevance_score: 0.5 }] } }));
  const client = new ModelClient(modelsCfg({ openrouter: undefined }));
  const scores = await client.rerank("query", ["a"], 2000);
  assert.deepEqual(scores, [0.5]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(LOCAL_RERANK));
});

test("health: reports cloud provider state when configured", async () => {
  stubFetch(() => "refuse"); // local pings fail — irrelevant to the cloud field
  const health = await new ModelClient(modelsCfg()).health();
  assert.deepEqual(health.cloud, { provider: "openrouter", prefer: "cloud", breaker: "closed" });
  const noCloud = await new ModelClient(modelsCfg({ openrouter: undefined })).health();
  assert.equal(noCloud.cloud, undefined);
});
