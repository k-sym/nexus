// Daemon entry point. Boot order: config -> open DB -> ghost-job recovery (P3)
// -> start vault watcher (P2) -> listen.
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDb, oplog } from "./db/index.js";
import { ModelClient } from "./models/client.js";
import { buildServer } from "./server.js";
import type { AppContext } from "./context.js";
import { reindexAll } from "./sync/reindex.js";
import { startWatcher } from "./sync/watcher.js";
import { recoverGhostJobs } from "./jobs/recovery.js";
import { startWorker } from "./jobs/worker.js";

async function main() {
  const cfg = loadConfig();
  mkdirSync(cfg.vaultPath, { recursive: true });

  const db = openDb(cfg.dbPath);
  const models = new ModelClient(cfg.models);
  const ctx: AppContext = { cfg, db, models, inflight: new Set<string>() };

  oplog(db, "boot", { detail: `vault=${cfg.vaultPath}` });

  // Reset any jobs stuck in PROCESSING from a previous crash. Reconcile the vault
  // before starting the worker so boot-time indexing cannot race queued derived work.
  const recovered = recoverGhostJobs(db);
  if (recovered > 0) console.log(`[nexus-memory] ghost recovery: ${recovered} job(s) reset to PENDING`);

  // Rebuild the index from the canonical vault, then watch for deltas.
  const stats = await reindexAll(ctx);
  console.log(`[nexus-memory] reindex: ${JSON.stringify(stats)}`);
  const worker = startWorker(ctx);
  const watcher = startWatcher(ctx);

  const app = buildServer(ctx);
  await app.listen({ host: cfg.host, port: cfg.port });
  console.log(`[nexus-memory] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[nexus-memory] vault=${cfg.vaultPath}`);
  console.log(`[nexus-memory] db=${cfg.dbPath}`);

  const shutdown = async (sig: string) => {
    console.log(`[nexus-memory] ${sig} — shutting down`);
    try {
      worker.stop();
      await watcher.close();
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[nexus-memory] fatal:", err);
  process.exit(1);
});
