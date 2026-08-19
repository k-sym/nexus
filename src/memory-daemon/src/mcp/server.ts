// MCP tool surface for CLI agents (Claude Code / Codex). Tools are thin wrappers
// over the daemon HTTP API via MemoryClient — no direct DB access, so the daemon stays the
// single writer. Stores default to the `global` namespace (the one global recall reads) unless
// env defaults pin a project scope — an omitted namespace must never file a memory where
// recall can't see it (2026-08-14 incident: the old `openclaw` default swallowed vault pages).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemoryClient } from "../client.js";
import { mergeScope, type McpEnvDefaults } from "./scope.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

const scopeShape = {
  namespace: z.string().optional(),
  project: z.string().optional(),
  category: z.string().optional(),
  scope: z.enum(["isolated", "cross"]).optional(),
};

export function buildMcpServer(client: MemoryClient, opts?: { defaults?: McpEnvDefaults }): McpServer {
  const defaults: McpEnvDefaults = opts?.defaults ?? { readonly: false };
  const server = new McpServer({ name: "nexus-memory", version: "0.1.0" });

  server.tool(
    "memory_recall",
    "Recall relevant memories for a query as injection-ready context (with citations + KG facts).",
    { query: z.string(), ...scopeShape, limit: z.number().int().positive().optional() },
    async (a) => {
      const r = await client.recall(a.query, mergeScope(a, defaults), a.limit);
      const cites = r.items.map((it) => `- ${it.title ?? it.id} [${it.namespace}${it.project ? "/" + it.project : ""}]`).join("\n");
      return asText(r.context ? `${r.context}\n\n— sources —\n${cites}` : "(no relevant memories)");
    },
  );

  server.tool(
    "memory_search",
    "Search memories and return structured results (titles, matched sentences, scores).",
    { query: z.string(), ...scopeShape, limit: z.number().int().positive().optional() },
    async (a) => asText(await client.search(a.query, mergeScope(a, defaults), a.limit)),
  );

  if (!defaults.readonly) {
    server.tool(
      "memory_store",
      "Store a new memory. It is written to the canonical Obsidian vault and indexed. Defaults to the 'global' namespace when none is given.",
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
            namespace: a.namespace ?? defaults.namespace ?? "global",
            project: a.project ?? defaults.project ?? null,
            category: a.category ?? null,
            source: a.source ?? "mcp",
          }),
        ),
    );
  }

  server.tool("memory_get", "Fetch a single memory by id.", { id: z.string() }, async (a) => asText(await client.get(a.id)));

  server.tool(
    "memory_list",
    "List recent memories (optionally scoped by namespace/project/category).",
    { ...scopeShape, limit: z.number().int().positive().optional() },
    async (a) => asText(await client.list(mergeScope(a, defaults), a.limit)),
  );

  if (!defaults.readonly) {
    server.tool("memory_prune", "Delete a memory by id (removes its markdown file).", { id: z.string() }, async (a) =>
      asText(await client.remove(a.id)),
    );
  }

  return server;
}
