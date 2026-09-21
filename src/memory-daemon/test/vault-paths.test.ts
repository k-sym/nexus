// Where pages land, and what happens when they (or the whole vault) move.
//   1. global meeting pages file under "Meeting Notes/", captures stay in Memories/,
//      nexus project pages keep their Projects tree
//   2. a page moved without a content change keeps its row (file_path follows the file,
//      reindex does not soft-delete it)
//   3. an index with live rows and a MISSING vault root is an unmounted vault, not an
//      emptied one: waitForVault waits (then gives up), reindexAll keeps every row —
//      while a present tree with a page deleted still gets that page soft-deleted
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/context.js";
import type { DaemonConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import type { ModelClient } from "../src/models/client.js";
import { ingestFile, scopeToPath, storeMemory } from "../src/sync/ingest.js";
import { reindexAll, waitForVault } from "../src/sync/reindex.js";
import { VAULT_MARKER, vaultReady } from "../src/sync/marker.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexus-vault-paths-"));
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

function row(ctx: AppContext, id: string): { file_path: string; deleted_at: string | null } {
  return ctx.db.prepare("SELECT file_path, deleted_at FROM memories WHERE id = ?").get(id) as {
    file_path: string;
    deleted_at: string | null;
  };
}

test("scopeToPath: meeting pages get Meeting Notes/, everything else global stays in Memories/", () => {
  assert.equal(scopeToPath("/v", { namespace: "global", category: "meeting" }, "A"), "/v/Meeting Notes/A.md");
  assert.equal(scopeToPath("/v", { namespace: "global", category: "Meeting", project: "x" }, "A"), "/v/Meeting Notes/A.md");
  assert.equal(scopeToPath("/v", { namespace: "global", category: "capture" }, "A"), "/v/Memories/A.md");
  assert.equal(scopeToPath("/v", { namespace: "global" }, "A"), "/v/Memories/A.md");
  assert.equal(scopeToPath("/v", { namespace: "nexus", project: "p", category: "meeting" }, "A"), "/v/Nexus/Projects/p/Meeting/A.md");
});

test("storeMemory writes a meeting page into Meeting Notes/ and indexes it there", async () => {
  const f = fixture();
  try {
    const res = await storeMemory(f.ctx, { namespace: "global", category: "meeting", source: "conversate", title: "M", body: "hello" });
    const r = row(f.ctx, res.id);
    assert.equal(r.file_path, join(f.ctx.cfg.vaultPath, "Meeting Notes", `${res.id}.md`));
    assert.ok(existsSync(r.file_path));
  } finally {
    f.close();
  }
});

test("a page moved without changes keeps its row: file_path follows, reindex removes nothing", async () => {
  const f = fixture();
  try {
    const res = await storeMemory(f.ctx, { namespace: "global", category: "meeting", source: "conversate", title: "M", body: "hello" });
    const from = row(f.ctx, res.id).file_path;
    const to = join(f.ctx.cfg.vaultPath, "Memories", `${res.id}.md`);
    mkdirSync(join(f.ctx.cfg.vaultPath, "Memories"), { recursive: true });
    renameSync(from, to);
    const again = await ingestFile(f.ctx, to);
    assert.equal(again?.action, "noop");
    assert.equal(row(f.ctx, res.id).file_path, to);
    const stats = await reindexAll(f.ctx);
    assert.equal(stats.removed, 0);
    assert.equal(row(f.ctx, res.id).deleted_at, null);
  } finally {
    f.close();
  }
});

test("a missing vault root never empties a populated index", async () => {
  const f = fixture();
  try {
    const res = await storeMemory(f.ctx, { namespace: "global", category: "capture", source: "test", body: "keep me" });
    rmSync(f.ctx.cfg.vaultPath, { recursive: true, force: true });
    const t0 = Date.now();
    assert.equal(await waitForVault(f.ctx, { timeoutMs: 60, pollMs: 10 }), false);
    assert.ok(Date.now() - t0 >= 50, "waited for the timeout");
    assert.ok(!existsSync(f.ctx.cfg.vaultPath), "did not create an empty vault over the missing one");
    const stats = await reindexAll(f.ctx);
    assert.equal(stats.removed, 0);
    assert.equal(row(f.ctx, res.id).deleted_at, null);
  } finally {
    f.close();
  }
});

test("folders present but nothing hydrated (no marker, no markdown) keeps the index", async () => {
  const f = fixture();
  try {
    const res = await storeMemory(f.ctx, { namespace: "global", category: "meeting", source: "test", body: "keep" });
    assert.ok(vaultReady(f.ctx.cfg.vaultPath), "storeMemory stamped the vault");
    rmSync(f.ctx.cfg.vaultPath, { recursive: true, force: true });
    mkdirSync(join(f.ctx.cfg.vaultPath, "Memories"), { recursive: true }); // what a placeholder mount looks like
    assert.equal(await waitForVault(f.ctx, { timeoutMs: 40, pollMs: 10 }), false);
    const stats = await reindexAll(f.ctx);
    assert.equal(stats.removed, 0);
    assert.equal(row(f.ctx, res.id).deleted_at, null);
  } finally {
    f.close();
  }
});

test("a vault indexed before markers existed is stamped on the first boot that finds markdown", async () => {
  const f = fixture();
  try {
    await storeMemory(f.ctx, { namespace: "global", category: "capture", source: "test", body: "old" });
    rmSync(join(f.ctx.cfg.vaultPath, VAULT_MARKER));
    assert.equal(vaultReady(f.ctx.cfg.vaultPath), false);
    assert.equal(await waitForVault(f.ctx, { timeoutMs: 10, pollMs: 5 }), true);
    assert.ok(vaultReady(f.ctx.cfg.vaultPath));
  } finally {
    f.close();
  }
});

test("a present vault with a page deleted still soft-deletes that page", async () => {
  const f = fixture();
  try {
    const res = await storeMemory(f.ctx, { namespace: "global", category: "meeting", source: "test", body: "gone" });
    rmSync(row(f.ctx, res.id).file_path);
    assert.equal(await waitForVault(f.ctx, { timeoutMs: 10, pollMs: 5 }), true);
    const stats = await reindexAll(f.ctx);
    assert.equal(stats.removed, 1);
    assert.notEqual(row(f.ctx, res.id).deleted_at, null);
  } finally {
    f.close();
  }
});

test("waitForVault creates the directory for a fresh, empty index", async () => {
  const f = fixture();
  try {
    assert.equal(await waitForVault(f.ctx, { timeoutMs: 10, pollMs: 5 }), true);
    assert.ok(existsSync(f.ctx.cfg.vaultPath));
    assert.ok(vaultReady(f.ctx.cfg.vaultPath), "fresh vault is stamped");
  } finally {
    f.close();
  }
});
