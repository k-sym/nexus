// MCP tool surface for OpenClaw's CLI agents (Claude Code / Codex). Tools are thin wrappers
// over the daemon HTTP API via MemoryClient — no direct DB access, so the daemon stays the
// single writer. Defaults target the `openclaw` namespace since that's the primary MCP caller.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryClient } from "../client.js";
import type { ScopeFilter } from "../retrieval/types.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

const scopeShape = {
  namespace: z.string().optional(),
  project: z.string().optional(),
  scope: z.enum(["isolated", "cross"]).optional(),
};
const toFilter = (a: { namespace?: string; project?: string; scope?: "isolated" | "cross" }): ScopeFilter => ({
  namespace: a.namespace,
  project: a.project,
  scope: a.scope,
});

export function buildMcpServer(client: MemoryClient): McpServer {
  const server = new McpServer({ name: "nexus-memory", version: "0.1.0" });

  server.tool(
    "memory_recall",
    "Recall relevant memories for a query as injection-ready context (with citations + KG facts).",
    { query: z.string(), ...scopeShape, limit: z.number().int().positive().optional() },
    async (a) => {
      const r = await client.recall(a.query, toFilter(a), a.limit);
      const cites = r.items.map((it) => `- ${it.title ?? it.id} [${it.namespace}${it.project ? "/" + it.project : ""}]`).join("\n");
      return asText(r.context ? `${r.context}\n\n— sources —\n${cites}` : "(no relevant memories)");
    },
  );

  server.tool(
    "memory_search",
    "Search memories and return structured results (titles, matched sentences, scores).",
    { query: z.string(), ...scopeShape, limit: z.number().int().positive().optional() },
    async (a) => asText(await client.search(a.query, toFilter(a), a.limit)),
  );

  server.tool(
    "memory_store",
    "Store a new memory. It is written to the canonical Obsidian vault and indexed.",
    {
      body: z.string(),
      title: z.string().optional(),
      namespace: z.string().optional(),
      project: z.string().optional(),
      category: z.string().optional(),
      source: z.string().optional(),
    },
    async (a) =>
      asText(
        await client.store({
          body: a.body,
          title: a.title,
          namespace: a.namespace ?? "openclaw",
          project: a.project ?? null,
          category: a.category ?? null,
          source: a.source ?? "openclaw",
        }),
      ),
  );

  server.tool("memory_get", "Fetch a single memory by id.", { id: z.string() }, async (a) => asText(await client.get(a.id)));

  server.tool(
    "memory_list",
    "List recent memories (optionally scoped by namespace/project).",
    { ...scopeShape, limit: z.number().int().positive().optional() },
    async (a) => asText(await client.list(toFilter(a), a.limit)),
  );

  server.tool("memory_prune", "Delete a memory by id (removes its markdown file).", { id: z.string() }, async (a) =>
    asText(await client.remove(a.id)),
  );

  return server;
}
