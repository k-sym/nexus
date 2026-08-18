// Recall must survive a slow/queued reranker: the configured rerank deadline is passed
// through to the model client, and on timeout recall degrades to fusion order instead of
// holding the caller (interactive consumers budget ~2.5s end-to-end).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/context.js";
import type { DaemonConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ModelError, type ModelClient } from "../src/models/client.js";
import { storeMemory } from "../src/sync/ingest.js";
import { embedPending } from "../src/index/indexer.js";
import { recall } from "../src/retrieval/recall.js";

function fixture(models: Partial<ModelClient>) {
  const root = mkdtempSync(join(tmpdir(), "nexus-recall-timeout-"));
  const cfg: DaemonConfig = {
    host: "127.0.0.1",
    port: 4100,
    vaultPath: join(root, "vault"),
    dbPath: join(root, "index.db"),
    models: {
      genUrl: "http://127.0.0.1:1",
      embedUrl: "http://127.0.0.1:1",
      embedModel: "test",
      rerankUrl: "http://127.0.0.1:1",
      rerankModel: "test",
    },
    retrieval: { hyde: false, sentenceThreshold: 0, sentenceK: 10, chunkK: 10, rerankK: 25, rerankTimeoutMs: 1234, tokenBudget: 1000 },
  };
  const ctx: AppContext = { cfg, db: openDb(cfg.dbPath), models: models as ModelClient, inflight: new Set() };
  return {
    ctx,
    close() {
      ctx.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const fakeEmbed = async (input: string | string[]) =>
  (Array.isArray(input) ? input : [input]).map(() => new Array(768).fill(0.1));

test("recall passes the configured rerank deadline to the model client", async () => {
  let seenTimeout: number | undefined;
  const f = fixture({
    embed: fakeEmbed,
    rerank: async (_q: string, docs: string[], timeoutMs?: number) => {
      seenTimeout = timeoutMs;
      return docs.map(() => 0.5);
    },
  } as Partial<ModelClient>);
  try {
    const stored = await storeMemory(f.ctx, { namespace: "nexus", source: "test", body: "the copilot cue loop reads recall output" });
    await embedPending(f.ctx, stored.id, "sentence"); // sentence vecs normally land via the deep_index job
    const res = await recall(f.ctx, "cue loop");
    assert.equal(seenTimeout, 1234);
    assert.equal(res.degraded, false);
  } finally {
    f.close();
  }
});

test("recall degrades to fusion order when the reranker times out", async () => {
  const f = fixture({
    embed: fakeEmbed,
    rerank: async (_q: string, _docs: string[], timeoutMs?: number) => {
      throw new ModelError(`timed out after ${timeoutMs}ms`, "transport", "http://127.0.0.1:1/rerank");
    },
  } as Partial<ModelClient>);
  try {
    const stored = await storeMemory(f.ctx, { namespace: "nexus", source: "test", body: "the copilot cue loop reads recall output" });
    await embedPending(f.ctx, stored.id, "sentence");
    const res = await recall(f.ctx, "cue loop");
    assert.equal(res.degraded, true);
    assert.ok(res.items.length > 0, "fusion-ordered items still returned");
    assert.ok(typeof res.timings?.total === "number", "stage timings reported");
  } finally {
    f.close();
  }
});
