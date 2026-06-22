import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/context.js";
import type { DaemonConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import type { ModelClient } from "../src/models/client.js";
import { storeMemory } from "../src/sync/ingest.js";
import { reindexAll, type ReindexStats } from "../src/sync/reindex.js";
import { clearNexusMemory, maintenanceCoordinatorFor } from "../src/maintenance.js";
import { buildServer } from "../src/server.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexus-maintenance-"));
  const vaultPath = join(root, "vault");
  const cfg: DaemonConfig = {
    host: "127.0.0.1",
    port: 4100,
    vaultPath,
    dbPath: join(root, "index.db"),
    models: {
      genUrl: "http://127.0.0.1:1",
      embedUrl: "http://127.0.0.1:1",
      embedModel: "test",
      rerankUrl: "http://127.0.0.1:1",
      rerankModel: "test",
    },
    retrieval: { hyde: false, sentenceThreshold: 0, sentenceK: 1, chunkK: 1, rerankK: 1, tokenBudget: 100 },
  };
  const models = {
    embed: async (input: string | string[]) =>
      (Array.isArray(input) ? input : [input]).map(() => new Array(768).fill(0)),
    health: async () => ({ gen: true, embed: true, rerank: true }),
  } as unknown as ModelClient;
  const ctx: AppContext = { cfg, db: openDb(cfg.dbPath), models, inflight: new Set() };
  return {
    root,
    ctx,
    close() {
      ctx.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function liveCount(ctx: AppContext, namespace: string): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE namespace = ? AND deleted_at IS NULL").get(namespace) as { n: number }).n;
}

test("forced rebuild preserves markdown and refreshes unchanged memory", async () => {
  const f = fixture();
  try {
    const stored = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "unchanged memory" });
    const nexusPath = (f.ctx.db.prepare("SELECT file_path FROM memories WHERE id = ?").get(stored.id) as { file_path: string }).file_path;
    const before = readFileSync(nexusPath, "utf8");

    const stats = await reindexAll(f.ctx, { force: true });

    assert.equal(readFileSync(nexusPath, "utf8"), before);
    assert.equal(stats.reindexed, 1);
    assert.ok(stats.queued >= 1);
  } finally {
    f.close();
  }
});

test("forced rebuild clears stale knowledge graph facts before re-extraction", async () => {
  const f = fixture();
  try {
    const stored = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "changed facts" });
    f.ctx.db.prepare(
      "INSERT INTO facts (memory_id, subject, relation, object, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(stored.id, "old", "related_to", "fact", new Date().toISOString());

    await reindexAll(f.ctx, { force: true });

    const facts = (f.ctx.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE memory_id = ?").get(stored.id) as { n: number }).n;
    assert.equal(facts, 0);
  } finally {
    f.close();
  }
});

test("forced rebuild reports jobs enqueued by this scan despite queue status changes", async () => {
  const f = fixture();
  try {
    const stored = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "queue accounting" });
    f.ctx.db.prepare("DELETE FROM embed_cache").run();
    let changedStatus = false;
    f.ctx.models.embed = async (input: string | string[]) => {
      if (!changedStatus) {
        changedStatus = true;
        f.ctx.db.prepare("UPDATE jobs SET status = 'PROCESSING' WHERE status = 'PENDING'").run();
      }
      return (Array.isArray(input) ? input : [input]).map(() => new Array(768).fill(0));
    };

    const stats = await reindexAll(f.ctx, { force: true });

    assert.equal(stats.reindexed, 1);
    assert.equal(stats.queued, 1);
    assert.ok(stored.id);
  } finally {
    f.close();
  }
});

test("clear removes only nexus canonical memory", async () => {
  const f = fixture();
  try {
    const nexus = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "nexus" });
    const global = await storeMemory(f.ctx, { namespace: "global", source: "test", body: "global" });
    const pathFor = (id: string) => (f.ctx.db.prepare("SELECT file_path FROM memories WHERE id = ?").get(id) as { file_path: string }).file_path;
    const nexusPath = pathFor(nexus.id);
    const globalPath = pathFor(global.id);
    f.ctx.db.prepare(
      "INSERT INTO facts (memory_id, subject, relation, object, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(nexus.id, "private", "related_to", "fact", new Date().toISOString());
    const unrelatedPath = join(f.ctx.cfg.vaultPath, "unrelated.txt");
    mkdirSync(f.ctx.cfg.vaultPath, { recursive: true });
    writeFileSync(unrelatedPath, "leave me alone");

    const result = clearNexusMemory(f.ctx);

    assert.equal(result.deleted, 1);
    assert.equal(existsSync(nexusPath), false);
    assert.equal(existsSync(globalPath), true);
    assert.equal(existsSync(unrelatedPath), true);
    assert.equal(liveCount(f.ctx, "nexus"), 0);
    assert.equal(liveCount(f.ctx, "global"), 1);
    const facts = (f.ctx.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE memory_id = ?").get(nexus.id) as { n: number }).n;
    assert.equal(facts, 0);
  } finally {
    f.close();
  }
});

test("clear refuses indexed paths outside the vault and non-Markdown files", async () => {
  const f = fixture();
  try {
    const outsidePath = join(f.root, "outside.md");
    const nonMarkdownPath = join(f.ctx.cfg.vaultPath, "Nexus", "do-not-delete.txt");
    mkdirSync(join(f.ctx.cfg.vaultPath, "Nexus"), { recursive: true });
    writeFileSync(outsidePath, "outside");
    writeFileSync(nonMarkdownPath, "not markdown");

    const first = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "first" });
    const second = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "second" });
    f.ctx.db.prepare("UPDATE memories SET file_path = ? WHERE id = ?").run(outsidePath, first.id);
    f.ctx.db.prepare("UPDATE memories SET file_path = ? WHERE id = ?").run(nonMarkdownPath, second.id);

    const result = clearNexusMemory(f.ctx);

    assert.equal(result.deleted, 0);
    assert.equal(result.failed, 2);
    assert.equal(existsSync(outsidePath), true);
    assert.equal(existsSync(nonMarkdownPath), true);
    assert.deepEqual(result.paths, []);
    assert.deepEqual(result.failures.map((failure) => failure.path), ["outside.md", "Nexus/do-not-delete.txt"]);
    assert.ok(result.failures.every((failure) => failure.error === "Refusing to delete a path outside the canonical Markdown vault"));
  } finally {
    f.close();
  }
});

test("reindex removes all derived state for missing canonical files", async () => {
  const f = fixture();
  try {
    const stored = await storeMemory(f.ctx, { namespace: "nexus", project: "test", source: "test", body: "stale memory" });
    const filePath = (f.ctx.db.prepare("SELECT file_path FROM memories WHERE id = ?").get(stored.id) as { file_path: string }).file_path;
    f.ctx.db.prepare(
      "INSERT INTO facts (memory_id, subject, relation, object, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(stored.id, "stale", "related_to", "fact", new Date().toISOString());
    rmSync(filePath);

    const stats = await reindexAll(f.ctx);

    assert.equal(stats.removed, 1);
    for (const table of ["chunks", "sentences", "facts"] as const) {
      const count = (f.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE memory_id = ?`).get(stored.id) as { n: number }).n;
      assert.equal(count, 0, `${table} should be cleaned`);
    }
    const fts = (f.ctx.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memory_id = ?").get(stored.id) as { n: number }).n;
    assert.equal(fts, 0);
    for (const table of ["chunk_vec", "sentence_vec"] as const) {
      const vectors = (f.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.equal(vectors, 0, `${table} should be cleaned`);
    }
  } finally {
    f.close();
  }
});

test("maintenance coordinator drains worker work and blocks new worker work", async () => {
  const f = fixture();
  const coordinator = maintenanceCoordinatorFor(f.ctx);
  let releaseWorker!: () => void;
  let releaseMaintenance!: () => void;
  const workerBlocked = new Promise<void>((resolve) => { releaseWorker = resolve; });
  const maintenanceBlocked = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
  const events: string[] = [];
  try {
    const worker = coordinator.runWorker(async () => { events.push("worker-start"); await workerBlocked; events.push("worker-end"); });
    await Promise.resolve();
    const maintenance = coordinator.runMaintenance("rebuild", async () => {
      events.push("maintenance-start");
      await maintenanceBlocked;
      events.push("maintenance-end");
      return "done";
    });
    const laterWorker = coordinator.runWorker(async () => { events.push("later-worker"); });
    await Promise.resolve();
    assert.deepEqual(events, ["worker-start"]);
    assert.equal((await coordinator.runMaintenance("clear", async () => "unexpected")).acquired, false);

    releaseWorker();
    await worker;
    await Promise.resolve();
    assert.deepEqual(events, ["worker-start", "worker-end", "maintenance-start"]);
    releaseMaintenance();
    assert.deepEqual(await maintenance, { acquired: true, value: "done" });
    await laterWorker;
    assert.deepEqual(events, ["worker-start", "worker-end", "maintenance-start", "maintenance-end", "later-worker"]);
  } finally {
    f.close();
  }
});

test("maintenance routes validate confirmation and reject overlap", async () => {
  const f = fixture();
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<ReindexStats>((resolve) => {
    release = () => resolve({ scanned: 0, inserted: 0, updated: 0, noop: 0, removed: 0, reindexed: 0, queued: 0 });
  });
  const app = buildServer(f.ctx, {
    rebuild: async () => { markStarted(); return blocked; },
    clearNexus: () => ({ namespace: "nexus", deleted: 0, failed: 0, paths: [], failures: [] }),
    reconcile: () => reindexAll(f.ctx),
  });
  try {
    const bad = await app.inject({ method: "POST", url: "/operations/clear-nexus", payload: { confirmation: "wrong" } });
    assert.equal(bad.statusCode, 400);
    const first = app.inject({ method: "POST", url: "/operations/rebuild-index" });
    await started;
    const conflict = await app.inject({ method: "POST", url: "/operations/rebuild-index" });
    assert.equal(conflict.statusCode, 409);
    release();
    assert.equal((await first).statusCode, 200);
  } finally {
    await app.close();
    f.close();
  }
});

test("memory mutations wait until active maintenance finishes", async () => {
  const f = fixture();
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<ReindexStats>((resolve) => {
    release = () => resolve({ scanned: 0, inserted: 0, updated: 0, noop: 0, removed: 0, reindexed: 0, queued: 0 });
  });
  const app = buildServer(f.ctx, {
    rebuild: async () => { markStarted(); return blocked; },
    clearNexus: () => ({ namespace: "nexus", deleted: 0, failed: 0, paths: [], failures: [] }),
    reconcile: () => reindexAll(f.ctx),
  });
  try {
    const maintenance = app.inject({ method: "POST", url: "/operations/rebuild-index" });
    await started;
    let mutationFinished = false;
    const mutation = app.inject({
      method: "POST",
      url: "/memories",
      payload: { namespace: "nexus", source: "test", body: "created after maintenance" },
    }).then((response) => { mutationFinished = true; return response; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(mutationFinished, false);
    assert.equal(liveCount(f.ctx, "nexus"), 0);

    release();
    assert.equal((await maintenance).statusCode, 200);
    assert.equal((await mutation).statusCode, 201);
    assert.equal(liveCount(f.ctx, "nexus"), 1);
  } finally {
    await app.close();
    f.close();
  }
});

test("maintenance routes return rebuild stats and relative clear paths", async () => {
  const f = fixture();
  const stats: ReindexStats = { scanned: 1, inserted: 0, updated: 1, noop: 0, removed: 0, reindexed: 1, queued: 1 };
  const app = buildServer(f.ctx, {
    rebuild: async () => stats,
    clearNexus: () => ({ namespace: "nexus", deleted: 1, failed: 0, paths: ["Nexus/test.md"], failures: [] }),
    reconcile: async () => ({ ...stats, reindexed: 0 }),
  });
  try {
    const rebuild = await app.inject({ method: "POST", url: "/operations/rebuild-index" });
    assert.equal(rebuild.statusCode, 200);
    assert.deepEqual(rebuild.json(), stats);
    const clear = await app.inject({ method: "POST", url: "/operations/clear-nexus", payload: { confirmation: "CLEAR NEXUS MEMORY" } });
    assert.equal(clear.statusCode, 200);
    assert.deepEqual(clear.json().paths, ["Nexus/test.md"]);
    assert.equal(clear.json().ok, true);
  } finally {
    await app.close();
    f.close();
  }
});

test("clear route retains partial result when reconciliation fails", async () => {
  const f = fixture();
  const app = buildServer(f.ctx, {
    rebuild: async () => ({ scanned: 0, inserted: 0, updated: 0, noop: 0, removed: 0, reindexed: 0, queued: 0 }),
    clearNexus: () => ({
      namespace: "nexus",
      deleted: 1,
      failed: 1,
      paths: ["Nexus/deleted.md"],
      failures: [{ path: "Nexus/retained.md", error: "Unable to delete canonical memory (EACCES)" }],
    }),
    reconcile: async () => { throw new Error("sensitive database detail"); },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/operations/clear-nexus",
      payload: { confirmation: "CLEAR NEXUS MEMORY" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().deleted, 1);
    assert.equal(response.json().failed, 1);
    assert.equal(response.json().ok, false);
    assert.equal(response.json().reconciliation, null);
    assert.equal(response.json().reconciliationError, "Index reconciliation failed");
    assert.doesNotMatch(response.body, /sensitive database detail/);
  } finally {
    await app.close();
    f.close();
  }
});
