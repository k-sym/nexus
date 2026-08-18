// Caller metadata rides along as extra frontmatter on store (thread_id/elided from
// session-archive, task_id from task summaries) — but can never rescope a memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/context.js";
import type { DaemonConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import type { ModelClient } from "../src/models/client.js";
import { storeMemory } from "../src/sync/ingest.js";
import { buildServer } from "../src/server.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexus-store-metadata-"));
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

function frontmatterOf(ctx: AppContext, id: string): Record<string, unknown> {
  const row = ctx.db
    .prepare("SELECT frontmatter_json FROM memories WHERE id = ?")
    .get(id) as { frontmatter_json: string };
  return JSON.parse(row.frontmatter_json);
}

test("storeMemory persists caller metadata as frontmatter (file + index)", async () => {
  const f = fixture();
  try {
    const stored = await storeMemory(f.ctx, {
      namespace: "nexus",
      project: "demo",
      category: "session_archive",
      source: "nexus:session-archive",
      body: "Archived session summary.",
      metadata: { thread_id: "thread-1", thread_title: "T1", elided: false },
    });

    const fm = frontmatterOf(f.ctx, stored.id);
    assert.equal(fm.thread_id, "thread-1");
    assert.equal(fm.thread_title, "T1");
    assert.equal(fm.elided, false);

    // The canonical markdown file carries the same frontmatter.
    const filePath = (f.ctx.db.prepare("SELECT file_path FROM memories WHERE id = ?").get(stored.id) as { file_path: string }).file_path;
    const raw = readFileSync(filePath, "utf8");
    assert.match(raw, /thread_id: thread-1/);
    assert.match(raw, /elided: false/);
  } finally {
    f.close();
  }
});

test("storeMemory metadata cannot override reserved identity/scope keys", async () => {
  const f = fixture();
  try {
    const stored = await storeMemory(f.ctx, {
      namespace: "nexus",
      project: "demo",
      source: "nexus",
      body: "Scope stays owned by the contract.",
      metadata: {
        id: "spoofed-id",
        namespace: "openclaw",
        project: "other",
        source: "spoofed",
        title: "spoofed title",
        kept: "yes",
        skipped: undefined,
      },
    });

    assert.notEqual(stored.id, "spoofed-id");
    const fm = frontmatterOf(f.ctx, stored.id);
    assert.equal(fm.id, stored.id);
    assert.equal(fm.namespace, "nexus");
    assert.equal(fm.source, "nexus");
    assert.equal(fm.project, "demo");
    assert.equal(fm.title, undefined);
    assert.equal(fm.kept, "yes");
    assert.equal("skipped" in fm, false);
  } finally {
    f.close();
  }
});

test("POST /memories forwards metadata; body update preserves it", async () => {
  const f = fixture();
  const app = buildServer(f.ctx);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/memories",
      payload: {
        namespace: "nexus",
        project: "demo",
        source: "nexus:session-archive",
        body: "Stored over HTTP.",
        metadata: { thread_id: "thread-9", elided: true },
      },
    });
    assert.equal(created.statusCode, 201);
    const { id } = created.json() as { id: string };
    assert.equal(frontmatterOf(f.ctx, id).thread_id, "thread-9");

    // PUT rewrites the file from stored frontmatter — metadata must survive edits.
    const updated = await app.inject({
      method: "PUT",
      url: `/memories/${id}`,
      payload: { body: "Edited body." },
    });
    assert.equal(updated.statusCode, 200);
    const fm = frontmatterOf(f.ctx, id);
    assert.equal(fm.thread_id, "thread-9");
    assert.equal(fm.elided, true);
  } finally {
    await app.close();
    f.close();
  }
});

test("POST /memories ignores a non-object metadata payload", async () => {
  const f = fixture();
  const app = buildServer(f.ctx);
  try {
    const created = await app.inject({
      method: "POST",
      url: "/memories",
      payload: { namespace: "nexus", source: "nexus", body: "No metadata.", metadata: ["not", "an", "object"] },
    });
    assert.equal(created.statusCode, 201);
    const { id } = created.json() as { id: string };
    const fm = frontmatterOf(f.ctx, id);
    assert.equal("0" in fm, false);
    assert.equal(fm.namespace, "nexus");
  } finally {
    await app.close();
    f.close();
  }
});
