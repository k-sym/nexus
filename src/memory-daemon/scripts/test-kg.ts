// Phase 5 verification — KG extraction + fusion. Requires 4001 (gen) + 4002 (embed) live.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ModelClient } from "../src/models/client.js";
import type { AppContext } from "../src/context.js";
import { storeMemory } from "../src/sync/ingest.js";
import { startWorker } from "../src/jobs/worker.js";
import { recall } from "../src/retrieval/recall.js";
import { extractTriples } from "../src/kg/extract.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
async function waitJobs(db: any, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const n = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('PENDING','PROCESSING')").get() as { n: number }).n;
    if (n === 0) return;
    await sleep(250);
  }
}

async function main() {
  process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-kg-"));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const models = new ModelClient(cfg.models);
  const ctx: AppContext = { cfg, db, models, inflight: new Set() };
  const h = await models.health();
  if (!h.gen || !h.embed) {
    console.error("need 4001 (gen) + 4002 (embed) live");
    process.exit(2);
  }
  const worker = startWorker(ctx);

  const r = await storeMemory(ctx, {
    namespace: "nexus",
    project: "alpha",
    source: "test",
    title: "Storage decisions",
    body: "Baker chose AES-256-GCM for encrypting backups. The project Nexus uses SQLite for its storage layer.",
  });
  await waitJobs(db);

  const facts = db.prepare("SELECT subject, relation, object FROM facts WHERE memory_id = ?").all(r.id) as Array<{
    subject: string;
    relation: string;
    object: string;
  }>;
  const blob = facts.map((f) => `${f.subject} ${f.relation} ${f.object}`).join(" | ");
  check("triples extracted from the memory", facts.length >= 1, `${facts.length}: ${blob}`);
  check("a triple references a key entity", /AES|SQLite|Nexus|Baker|backup/i.test(blob), blob || "none");

  const kgJob = db.prepare("SELECT status FROM jobs WHERE type='extract_kg' ORDER BY id DESC LIMIT 1").get() as { status: string };
  check("extract_kg job completed (DONE)", kgJob?.status === "DONE", kgJob?.status);

  // Recall attaches query-matched facts.
  const res = await recall(ctx, "which database does Nexus use?");
  const withFacts = res.items.find((it) => it.facts && it.facts.length > 0);
  check("recall attaches query-matched facts", !!withFacts, withFacts ? JSON.stringify(withFacts.facts) : "no facts attached");

  // Extraction failure dead-letters cleanly, retrieval unaffected.
  const badModels = Object.assign(Object.create(Object.getPrototypeOf(models)), models, { complete: async () => null });
  let threw = false;
  try {
    await extractTriples({ ...ctx, models: badModels } as AppContext, r.id);
  } catch {
    threw = true;
  }
  check("extraction throws when model is down (-> dead-letter)", threw);
  const stillWorks = await recall(ctx, "AES-256 encryption");
  check("retrieval still works despite KG failure", stillWorks.items.some((it) => it.id === r.id));

  worker.stop();
  db.close();
  console.log(failures === 0 ? "\nALL KG CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
