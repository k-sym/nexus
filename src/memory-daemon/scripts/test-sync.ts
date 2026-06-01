// Phase 2 verification — drives the real chokidar watcher against a throwaway vault
// and asserts the sync invariants. Run: NEXUS_HOME=/tmp/<x> tsx scripts/test-sync.ts
import { mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ModelClient } from "../src/models/client.js";
import type { AppContext } from "../src/context.js";
import { reindexAll } from "../src/sync/reindex.js";
import { startWatcher } from "../src/sync/watcher.js";
import { storeMemory } from "../src/sync/ingest.js";
import { parseMarkdown } from "../src/sync/identity.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "nexus-sync-"));
  process.env.NEXUS_HOME = home;
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const ctx: AppContext = { cfg, db, models: new ModelClient(cfg.models), inflight: new Set() };

  await reindexAll(ctx);
  const watcher = startWatcher(ctx);
  await sleep(400);

  const liveCount = () => (db.prepare("SELECT COUNT(*) n FROM memories WHERE deleted_at IS NULL").get() as { n: number }).n;
  const rowById = (id: string) => db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
  const jobsFor = (id: string) =>
    (db.prepare("SELECT COUNT(*) n FROM jobs WHERE payload LIKE ?").get(`%${id}%`) as { n: number }).n;

  // ── Test 1: programmatic store → one row, watcher does NOT re-trigger (echo) ──
  const r1 = await storeMemory(ctx, { namespace: "global", source: "nexus", title: "First", body: "hello world body" });
  check("store inserts exactly one row", liveCount() === 1 && r1.action === "insert");
  const f1 = rowById(r1.id).file_path as string;
  await sleep(1200); // give the watcher every chance to wrongly re-ingest
  check("no duplicate after echo window", liveCount() === 1);
  check("exactly one deep_index job enqueued (echo suppressed)", jobsFor(r1.id) === 1);

  // ── Test 2: external edit (bypass writer, like Obsidian) → row updates ──
  const before = rowById(r1.id);
  const edited = readFileSync(f1, "utf8").replace("hello world body", "hello world body\n\nEDITED EXTERNALLY");
  writeFileSync(f1, edited, "utf8");
  await sleep(1200);
  const after = rowById(r1.id);
  check("external edit updates the row", after.body.includes("EDITED EXTERNALLY") && after.content_hash !== before.content_hash);
  check("external edit kept the same id (no dup)", liveCount() === 1);

  // ── Test 3: external new file WITHOUT id → ingested + id injected into file ──
  const noIdPath = join(cfg.vaultPath, "Memories", "note-no-id.md");
  writeFileSync(noIdPath, "# Loose Note\n\nsome text with encryption keyword\n", "utf8");
  await sleep(1500);
  check("loose file ingested", liveCount() === 2);
  const injected = parseMarkdown(readFileSync(noIdPath, "utf8"));
  check("id injected into previously-idless file", typeof injected.id === "string" && injected.id.length > 0);
  const looseId = injected.id!;

  // ── Test 4: rename file (has id) → same id, file_path follows, no duplicate ──
  const renamed = join(cfg.vaultPath, "Memories", "renamed-note.md");
  renameSync(noIdPath, renamed);
  await sleep(1800);
  const looseRow = rowById(looseId);
  check("rename keeps the same id", looseRow && looseRow.deleted_at === null);
  check("rename updates file_path", looseRow?.file_path === renamed);
  check("rename created no duplicate", liveCount() === 2);

  // ── Test 5: delete file → soft delete ──
  rmSync(renamed);
  await sleep(1200);
  check("delete soft-deletes the row", rowById(looseId)?.deleted_at !== null);
  check("live count drops to 1", liveCount() === 1);

  // ── Disposable-index proof: wipe DB, rebuild from vault, state matches ──
  const liveFilesBefore = readdirSync(join(cfg.vaultPath, "Memories")).filter((f) => f.endsWith(".md")).length;
  await watcher.close();
  db.close();
  rmSync(cfg.dbPath, { force: true });
  rmSync(`${cfg.dbPath}-wal`, { force: true });
  rmSync(`${cfg.dbPath}-shm`, { force: true });
  const db2 = openDb(cfg.dbPath);
  const ctx2: AppContext = { ...ctx, db: db2 };
  const stats = await reindexAll(ctx2);
  const rebuilt = (db2.prepare("SELECT COUNT(*) n FROM memories WHERE deleted_at IS NULL").get() as { n: number }).n;
  check("rebuild-from-vault reproduces live memories", rebuilt === liveFilesBefore && rebuilt === 1);
  console.log(`   rebuild stats: ${JSON.stringify(stats)}`);
  db2.close();

  rmSync(home, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL SYNC INVARIANTS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
