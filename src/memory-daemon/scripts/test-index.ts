// Phase 3 verification — indexing pipeline + job queue.
// Requires the embed server (4002) live. Run: tsx scripts/test-index.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ModelClient } from "../src/models/client.js";
import type { AppContext } from "../src/context.js";
import { storeMemory } from "../src/sync/ingest.js";
import { startWorker } from "../src/jobs/worker.js";
import { enqueue, fail, type Job } from "../src/jobs/queue.js";
import { recoverGhostJobs } from "../src/jobs/recovery.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

const BODY =
  "We decided to rotate encryption keys nightly. The team chose AES-256 for storage. " +
  "Logging was deemed important for audits. We learned that backups must be tested regularly.";

async function main() {
  const home = mkdtempSync(join(tmpdir(), "nexus-index-"));
  process.env.NEXUS_HOME = home;
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const models = new ModelClient(cfg.models);
  const ctx: AppContext = { cfg, db, models, inflight: new Set() };

  const health = await models.health();
  if (!health.embed) {
    console.error("embed server (4002) not reachable — cannot run Phase 3 test");
    process.exit(2);
  }
  const worker = startWorker(ctx);

  const cnt = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const chunks = (id: string) => cnt("SELECT COUNT(*) n FROM chunks WHERE memory_id = ?", id);
  const chunksEmbedded = (id: string) => cnt("SELECT COUNT(*) n FROM chunks WHERE memory_id = ? AND embedded = 1", id);
  const sents = (id: string) => cnt("SELECT COUNT(*) n FROM sentences WHERE memory_id = ?", id);
  const sentsEmbedded = (id: string) => cnt("SELECT COUNT(*) n FROM sentences WHERE memory_id = ? AND embedded = 1", id);

  // ── Test A: instant chunk vectors + FTS; sentence vectors shortly after ──
  const a = await storeMemory(ctx, { namespace: "global", source: "nexus", title: "Decisions", body: BODY });
  check("chunks created", chunks(a.id) > 0);
  check("chunk vectors present immediately (inline)", chunksEmbedded(a.id) === chunks(a.id) && chunksEmbedded(a.id) > 0);
  const ftsHit = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH 'encrypt*'").get() as
    | { memory_id: string }
    | undefined;
  check("FTS keyword (prefix) searchable immediately", ftsHit?.memory_id === a.id);
  check("sentences created (unembedded at first)", sents(a.id) > 0);
  const sentReady = await waitFor(() => sentsEmbedded(a.id) === sents(a.id) && sents(a.id) > 0);
  check("sentence vectors appear after the async job", sentReady);

  // ── Test B: FNV-1a embed_cache dedup — identical content costs no new embeddings ──
  await waitFor(() => cnt("SELECT COUNT(*) n FROM jobs WHERE status = 'PENDING'") === 0);
  const callsBefore = models.embedCalls;
  const b = await storeMemory(ctx, { namespace: "global", source: "nexus", title: "Decisions copy", body: BODY });
  await waitFor(() => sentsEmbedded(b.id) === sents(b.id) && sents(b.id) > 0);
  check("identical re-save triggered zero new embeddings (dedup)", models.embedCalls === callsBefore);
  const cacheRows = cnt("SELECT COUNT(*) n FROM embed_cache");
  check("embed_cache populated", cacheRows > 0);

  // ── Test C: ghost-job recovery resets stuck PROCESSING jobs ──
  enqueue(db, "deep_index", { memory_id: a.id });
  const ghostId = (db.prepare("SELECT id FROM jobs WHERE status = 'PENDING' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  db.prepare("UPDATE jobs SET status = 'PROCESSING' WHERE id = ?").run(ghostId); // simulate crash mid-job
  const recovered = recoverGhostJobs(db);
  check("ghost recovery reset the stuck job", recovered >= 1);
  // Wait for the full queue to settle — the recovered deep_index also enqueues an extract_kg.
  const settled = await waitFor(() => cnt("SELECT COUNT(*) n FROM jobs WHERE status IN ('PENDING','PROCESSING')") === 0, 60000);
  const ghostStatus = (db.prepare("SELECT status FROM jobs WHERE id = ?").get(ghostId) as { status: string }).status;
  check("recovered job completed", ghostStatus === "DONE", ghostStatus);
  check("no jobs left stuck in PROCESSING", settled && cnt("SELECT COUNT(*) n FROM jobs WHERE status = 'PROCESSING'") === 0);

  // ── Test D: dead-letter after max_attempts (deterministic, no backoff wait) ──
  enqueue(db, "deep_index", { memory_id: "does-not-matter" });
  const dlId = (db.prepare("SELECT id FROM jobs WHERE status = 'PENDING' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  let outcome = "retry";
  for (let i = 0; i < 10 && outcome === "retry"; i++) {
    const j = db.prepare("SELECT id, type, payload, attempts, max_attempts FROM jobs WHERE id = ?").get(dlId) as Job;
    outcome = fail(db, j, "forced failure");
  }
  const dl = db.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(dlId) as { status: string; attempts: number };
  check("job lands in DEAD after 5 attempts", dl.status === "DEAD" && dl.attempts === 5);

  worker.stop();
  db.close();
  console.log(failures === 0 ? "\nALL INDEXING/QUEUE CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
