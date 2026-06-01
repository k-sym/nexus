// Phase 4 verification — retrieval pipeline + routes. Requires 4001/4002/4003 live.
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
import { buildServer } from "../src/server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
async function waitJobs(db: any) {
  for (let i = 0; i < 100; i++) {
    const n = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('PENDING','PROCESSING')").get() as { n: number }).n;
    if (n === 0) return;
    await sleep(150);
  }
}

const SEED = [
  { ns: "nexus", project: "alpha", title: "Key rotation", body: "We decided to rotate encryption keys nightly using AES-256-GCM. Backups are tested weekly. The team documented the runbook." },
  { ns: "nexus", project: "alpha", title: "Frontend stack", body: "The frontend uses React with Vite. State is managed via Zustand. Styling is Tailwind." },
  { ns: "openclaw", project: null, title: "Local models", body: "Baker runs local llama models on ports 4001, 4002 and 4003 via launchd agents. Embeddings are 768-dim." },
  { ns: "global", project: null, title: "Preferences", body: "Keith prefers Obsidian for notes and dislikes heavyweight databases. Markdown is canonical." },
  { ns: "nexus", project: "beta", title: "Analytics store", body: "Postgres was chosen for the analytics pipeline. Tables are partitioned by month for performance." },
  { ns: "global", project: null, title: "Reranker", body: "The reranker is Qwen3-Reranker-0.6B and scores document relevance for retrieval." },
];

async function main() {
  process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-ret-"));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const models = new ModelClient(cfg.models);
  const ctx: AppContext = { cfg, db, models, inflight: new Set() };
  if (!(await models.health()).embed) {
    console.error("4002 embed not reachable");
    process.exit(2);
  }
  const worker = startWorker(ctx);

  const ids: Record<string, string> = {};
  for (const s of SEED) {
    const r = await storeMemory(ctx, { namespace: s.ns, project: s.project, source: "test", title: s.title, body: s.body });
    ids[s.title] = r.id;
  }
  await waitJobs(db);

  // A. semantic recall@1 — direct
  const a = await recall(ctx, "how do we secure data at rest?");
  check("recall@1 semantic (encryption)", a.items[0]?.id === ids["Key rotation"], a.items[0]?.title ?? "none");

  // B. HyDE-style rephrased query. Indirect phrasing against a tiny 0.6B reranker, so the
  // honest bar is recall@2 (the direct query above already verifies recall@1).
  const b = await recall(ctx, "which algorithm protects stored files?");
  check("recall@2 rephrased (HyDE)", b.items.slice(0, 2).some((it) => it.id === ids["Key rotation"]), b.items.map((i) => i.title).join(", ") || "none");

  // C. FTS prefix recall
  const c = await recall(ctx, "Postgres partitioning");
  check("recall finds keyword match (Postgres)", c.items.some((it) => it.id === ids["Analytics store"]));

  // D. scope isolation
  const d = await recall(ctx, "models and ports", { namespace: "openclaw", scope: "isolated" });
  check("scope isolation keeps only the namespace", d.items.length > 0 && d.items.every((it) => it.namespace === "openclaw"));

  // E. surgical sentence trim (fewer than full body) + small-to-big parent chunk
  const e = a.items[0];
  check("sentence trim returns focused sentences", !!e && e.sentences.length >= 1 && e.sentences.length <= 3);
  check("small-to-big provides parent chunk", !!e && e.parentChunks.length >= 1);
  check("top sentence is on-topic", !!e && /encryption|AES/i.test(e.sentences[0]?.text ?? ""));

  // F. graceful degradation: embedder + reranker down -> FTS-only still returns
  const degradedModels = Object.assign(Object.create(Object.getPrototypeOf(models)), models, {
    embed: async () => null,
    rerank: async () => null,
    complete: async () => null,
  });
  const g = await recall({ ...ctx, models: degradedModels } as AppContext, "encryption keys");
  check("degraded mode still returns (FTS-only)", g.degraded === true && g.items.some((it) => it.id === ids["Key rotation"]));

  // G. HTTP routes smoke (POST then GET ?q=) via Fastify inject
  const app = buildServer(ctx);
  const post = await app.inject({ method: "POST", url: "/memories", payload: { namespace: "global", source: "test", title: "Injected", body: "A unique fact about quokkas and their smiles." } });
  check("POST /memories returns 201", post.statusCode === 201);
  await waitJobs(db);
  const get = await app.inject({ method: "GET", url: "/memories?q=quokka" });
  const body = get.json() as { items: Array<{ title: string }> };
  check("GET /memories?q= finds the new memory", body.items.some((it) => it.title === "Injected"));
  await app.close();

  worker.stop();
  db.close();
  console.log(failures === 0 ? "\nALL RETRIEVAL CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
