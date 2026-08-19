// Regression: GET /memories (the list branch, no ?q=) must apply every scope filter it
// accepts. The category filter was parsed and then dropped from the WHERE clause, so
// `?category=meeting` returned the whole mixed list — and callers that prune what they read
// back (partner reflect.sh, which asks for category=capture) were handed durable pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/context.js";
import type { DaemonConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import type { ModelClient } from "../src/models/client.js";
import { storeMemory } from "../src/sync/ingest.js";
import { buildServer } from "../src/server.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexus-list-scope-"));
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
      prefer: "local",
    },
    retrieval: { hyde: false, sentenceThreshold: 0, sentenceK: 1, chunkK: 1, rerankK: 1, rerankTimeoutMs: 2000, tokenBudget: 100 },
  };
  const models = {
    embed: async (input: string | string[]) =>
      (Array.isArray(input) ? input : [input]).map(() => new Array(768).fill(0)),
    health: async () => ({ gen: true, embed: true, rerank: true }),
  } as unknown as ModelClient;
  const ctx: AppContext = { cfg, db: openDb(cfg.dbPath), models, inflight: new Set() };
  return {
    ctx,
    close() {
      ctx.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ListItem {
  id: string;
  namespace: string;
  project: string | null;
  category: string | null;
}

async function seed(ctx: AppContext) {
  await storeMemory(ctx, { namespace: "global", category: "capture", source: "test", body: "global capture" });
  await storeMemory(ctx, { namespace: "global", category: "meeting", source: "test", body: "global meeting note" });
  await storeMemory(ctx, { namespace: "nexus", project: "baker-internal", category: "capture", source: "test", body: "nexus capture" });
  await storeMemory(ctx, { namespace: "nexus", project: "other", category: "project", source: "test", body: "nexus project state" });
}

async function list(app: ReturnType<typeof buildServer>, query: string): Promise<ListItem[]> {
  const res = await app.inject({ method: "GET", url: `/memories${query}` });
  assert.equal(res.statusCode, 200);
  return (res.json() as { items: ListItem[] }).items;
}

test("GET /memories narrows the list by category, namespace and project", async () => {
  const f = fixture();
  const app = buildServer(f.ctx);
  try {
    await seed(f.ctx);

    const all = await list(app, "?limit=100");
    assert.equal(all.length, 4);

    const captures = await list(app, "?category=capture&limit=100");
    assert.equal(captures.length, 2);
    assert.ok(captures.every((m) => m.category === "capture"));

    const meetings = await list(app, "?category=meeting&limit=100");
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0]?.category, "meeting");

    const globals = await list(app, "?namespace=global&limit=100");
    assert.equal(globals.length, 2);
    assert.ok(globals.every((m) => m.namespace === "global"));

    const project = await list(app, "?project=baker-internal&limit=100");
    assert.equal(project.length, 1);
    assert.equal(project[0]?.project, "baker-internal");

    // The filters compose — this is the exact shape reflect.sh asks for before it prunes.
    const globalCaptures = await list(app, "?namespace=global&category=capture&limit=100");
    assert.equal(globalCaptures.length, 1);
    assert.equal(globalCaptures[0]?.namespace, "global");
    assert.equal(globalCaptures[0]?.category, "capture");

    // An unmatched filter must return nothing rather than falling back to everything.
    assert.deepEqual(await list(app, "?category=no-such-category&limit=100"), []);
  } finally {
    await app.close();
    f.close();
  }
});
