// Phase 6 verification — MCP tools round-trip. Boots an ephemeral daemon HTTP server,
// links an in-memory MCP client<->server pair, and exercises store/recall/list/prune.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ModelClient } from "../src/models/client.js";
import type { AppContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { startWorker } from "../src/jobs/worker.js";
import { MemoryClient } from "../src/client.js";
import { buildMcpServer } from "../src/mcp/server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
const textOf = (res: any): string => (res?.content ?? []).map((c: any) => c.text).join("\n");
async function waitJobs(db: any, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('PENDING','PROCESSING')").get() as any).n === 0) return;
    await sleep(250);
  }
}

async function main() {
  process.env.NEXUS_HOME = mkdtempSync(join(tmpdir(), "nexus-mcp-"));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const ctx: AppContext = { cfg, db, models: new ModelClient(cfg.models), inflight: new Set() };
  if (!(await ctx.models.health()).embed) {
    console.error("4002 embed not reachable");
    process.exit(2);
  }
  const worker = startWorker(ctx);

  const app = buildServer(ctx);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  // Link an in-memory MCP client <-> server.
  const mcpServer = buildMcpServer(new MemoryClient(baseUrl));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check("tools advertised", ["memory_store", "memory_recall", "memory_search", "memory_list", "memory_prune"].every((n) => names.includes(n)), names.join(","));

  // store
  const stored = await client.callTool({
    name: "memory_store",
    arguments: { title: "Quokka", body: "Quokkas are small marsupials that always look like they are smiling." },
  });
  const storedId = JSON.parse(textOf(stored)).id as string;
  check("memory_store returns an id", typeof storedId === "string" && storedId.length > 0);
  await waitJobs(db);

  // recall
  const recalled = await client.callTool({ name: "memory_recall", arguments: { query: "which animal always looks like it is smiling?" } });
  check("memory_recall finds the stored memory", /quokka/i.test(textOf(recalled)), textOf(recalled).slice(0, 80));

  // list
  const listed = await client.callTool({ name: "memory_list", arguments: {} });
  check("memory_list includes it", /Quokka/.test(textOf(listed)));

  // prune
  await client.callTool({ name: "memory_prune", arguments: { id: storedId } });
  const after = (db.prepare("SELECT deleted_at FROM memories WHERE id = ?").get(storedId) as any)?.deleted_at;
  check("memory_prune soft-deletes", after !== null && after !== undefined);

  await client.close();
  await app.close();
  worker.stop();
  db.close();
  console.log(failures === 0 ? "\nALL MCP CHECKS PASSED ✅" : `\n${failures} CHECK(S) FAILED ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
