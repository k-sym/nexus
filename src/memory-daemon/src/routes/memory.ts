// Memory HTTP routes. Mirrors the contract the Nexus backend proxies; also backs the MCP tools.
import { unlinkSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { storeMemory, ingestFile, removeFile } from "../sync/ingest.js";
import { writeMemoryFile } from "../sync/writer.js";
import { recall, formatContext } from "../retrieval/recall.js";
import type { ScopeFilter } from "../retrieval/types.js";

interface StoreBody {
  namespace?: string;
  project?: string | null;
  category?: string | null;
  source?: string;
  title?: string;
  body?: string;
}

function scopeFromQuery(q: Record<string, unknown>): ScopeFilter {
  return {
    namespace: typeof q.namespace === "string" ? q.namespace : undefined,
    project: typeof q.project === "string" ? q.project : undefined,
    category: typeof q.category === "string" ? q.category : undefined,
    scope: q.scope === "isolated" ? "isolated" : "cross",
  };
}

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Create
  app.post("/memories", async (req, reply) => {
    const b = (req.body ?? {}) as StoreBody;
    if (!b.body || !b.namespace || !b.source) {
      return reply.code(400).send({ error: "namespace, source, and body are required" });
    }
    const res = await storeMemory(ctx, {
      namespace: b.namespace,
      project: b.project ?? null,
      category: b.category ?? null,
      source: b.source,
      title: b.title,
      body: b.body,
    });
    return reply.code(201).send(res);
  });

  // Search / recall (?q=) or list recent
  app.get("/memories", async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const filter = scopeFromQuery(q);
    const limit = typeof q.limit === "string" ? parseInt(q.limit, 10) : undefined;

    if (typeof q.q === "string" && q.q.trim().length > 0) {
      return recall(ctx, q.q, filter, { limit });
    }
    const scope = (filter.namespace ? " AND namespace = @namespace" : "") + (filter.project ? " AND project = @project" : "");
    const rows = ctx.db
      .prepare(
        `SELECT id, title, namespace, project, category, source, updated_at
         FROM memories WHERE deleted_at IS NULL${scope} ORDER BY updated_at DESC LIMIT @limit`,
      )
      .all({ namespace: filter.namespace ?? null, project: filter.project ?? null, limit: limit ?? 50 });
    return { items: rows };
  });

  // Read one
  app.get<{ Params: { id: string } }>("/memories/:id", async (req, reply) => {
    const row = ctx.db
      .prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  // Update body/title -> rewrite markdown -> reindex
  app.put<{ Params: { id: string }; Body: { title?: string; body?: string } }>("/memories/:id", async (req, reply) => {
    const row = ctx.db
      .prepare("SELECT frontmatter_json, body, file_path FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(req.params.id) as { frontmatter_json: string; body: string; file_path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });

    const fm = JSON.parse(row.frontmatter_json || "{}") as Record<string, unknown>;
    fm.updated = new Date().toISOString();
    if (typeof req.body?.title === "string") fm.title = req.body.title;
    const body = typeof req.body?.body === "string" ? req.body.body : row.body;

    writeMemoryFile(ctx, row.file_path, fm, body);
    const res = await ingestFile(ctx, row.file_path);
    return reply.send(res);
  });

  // Delete -> unlink the markdown file + soft-delete the row
  app.delete<{ Params: { id: string } }>("/memories/:id", async (req, reply) => {
    const row = ctx.db
      .prepare("SELECT file_path FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(req.params.id) as { file_path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    try {
      unlinkSync(row.file_path);
    } catch {
      /* already gone */
    }
    removeFile(ctx, row.file_path);
    return reply.send({ id: req.params.id, deleted: true });
  });

  // Injection-ready recall
  app.post("/recall", async (req, reply) => {
    const b = (req.body ?? {}) as { query?: string; limit?: number } & ScopeFilter;
    if (!b.query) return reply.code(400).send({ error: "query is required" });
    const res = await recall(ctx, b.query, { namespace: b.namespace, project: b.project, category: b.category, scope: b.scope }, { limit: b.limit });
    return reply.send({ ...res, context: formatContext(res) });
  });
}
