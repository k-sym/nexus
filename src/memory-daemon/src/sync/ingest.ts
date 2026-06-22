// Ingest a vault markdown file into the index (insert/update the memory row).
// Used by the watcher (external edits) and by reindex (full scan). Idempotent:
// re-ingesting unchanged content is a no-op (no redundant reindex jobs).
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ulid } from "ulid";
import type { AppContext } from "../context.js";
import { oplog } from "../db/index.js";
import { enqueue } from "../jobs/queue.js";
import { contentHash } from "./hash.js";
import { parseMarkdown, deriveScope, type Scope } from "./identity.js";
import { writeMemoryFile } from "./writer.js";
import { buildSegments, embedPending } from "../index/indexer.js";
import { deleteFts } from "../index/fts.js";
import { dropVectors } from "../index/embed.js";

export type IngestAction = "insert" | "update" | "noop";

function deriveTitle(body: string, filePath: string): string {
  const heading = body.match(/^\s*#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) return firstLine.slice(0, 120);
  return basename(filePath).replace(/\.md$/i, "");
}

export interface IngestResult {
  id: string;
  action: IngestAction;
}

/** Read the file at `filePath` and upsert its memory row (+ index its content). */
export async function ingestFile(
  ctx: AppContext,
  filePath: string,
  options: { force?: boolean } = {},
): Promise<IngestResult | null> {
  let raw: string;
  let mtime: number;
  try {
    raw = readFileSync(filePath, "utf8");
    mtime = Math.floor(statSync(filePath).mtimeMs);
  } catch {
    return null; // file vanished between event and read
  }

  const parsed = parseMarkdown(raw);
  let id = parsed.id;
  let fm = parsed.frontmatter;
  const body = parsed.body;
  let hash = contentHash(raw);

  // Ensure stable identity. If the file lacks an `id`, inject one and rewrite the file
  // (echo-suppressed via the writer) so rename-stability holds for every memory.
  if (!id) {
    id = ulid();
    fm = { ...fm, id };
    if (typeof fm.created !== "string") fm.created = new Date().toISOString();
    const wr = writeMemoryFile(ctx, filePath, fm, body);
    hash = wr.hash;
    mtime = wr.mtime;
  }

  const existing = ctx.db
    .prepare("SELECT id, content_hash, created_at, deleted_at FROM memories WHERE id = ?")
    .get(id) as { id: string; content_hash: string; created_at: string; deleted_at: string | null } | undefined;

  if (!options.force && existing && existing.content_hash === hash && existing.deleted_at === null) {
    return { id, action: "noop" };
  }

  const scope: Scope = deriveScope(filePath, ctx.cfg.vaultPath, fm);
  const title = typeof fm.title === "string" ? fm.title : deriveTitle(body, filePath);
  const now = new Date().toISOString();
  const createdAt =
    (typeof fm.created === "string" && fm.created) || existing?.created_at || now;
  const updatedAt = typeof fm.updated === "string" ? fm.updated : now;

  ctx.db
    .prepare(
      `INSERT INTO memories
         (id, namespace, project, category, source, title, body, frontmatter_json,
          file_path, content_hash, file_mtime, created_at, updated_at, deleted_at)
       VALUES (@id, @namespace, @project, @category, @source, @title, @body, @frontmatter_json,
          @file_path, @content_hash, @file_mtime, @created_at, @updated_at, NULL)
       ON CONFLICT(id) DO UPDATE SET
         namespace = excluded.namespace, project = excluded.project, category = excluded.category,
         source = excluded.source, title = excluded.title, body = excluded.body,
         frontmatter_json = excluded.frontmatter_json, file_path = excluded.file_path,
         content_hash = excluded.content_hash, file_mtime = excluded.file_mtime,
         updated_at = excluded.updated_at, deleted_at = NULL`,
    )
    .run({
      id,
      namespace: scope.namespace,
      project: scope.project,
      category: scope.category,
      source: scope.source,
      title,
      body,
      frontmatter_json: JSON.stringify(fm),
      file_path: filePath,
      content_hash: hash,
      file_mtime: mtime,
      created_at: createdAt,
      updated_at: updatedAt,
    });

  // Keep sync_state authoritative for this path.
  ctx.db
    .prepare(
      `INSERT INTO sync_state (file_path, memory_id, last_mtime, last_indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         memory_id = excluded.memory_id, last_mtime = excluded.last_mtime,
         last_indexed_at = excluded.last_indexed_at`,
    )
    .run(filePath, id, mtime, now);

  const action: IngestAction = existing ? "update" : "insert";
  oplog(ctx.db, action === "insert" ? "ingest" : "update", { memory_id: id, source: scope.source });

  // Instant + local: FTS + chunk/sentence rows -> keyword-searchable immediately.
  if (options.force) ctx.db.prepare("DELETE FROM facts WHERE memory_id = ?").run(id);
  buildSegments(ctx, id, title, body);
  // Instant chunk vectors when the embedder is up; the deep_index job backfills + does
  // sentences. Embedder downtime degrades gracefully (FTS still works).
  try {
    await embedPending(ctx, id, "chunk");
  } catch {
    /* leave embedded=0; the deep_index job retries with backoff */
  }
  enqueue(ctx.db, "deep_index", { memory_id: id });
  return { id, action };
}

/** Soft-delete the memory backed by a now-removed file. */
export function removeFile(ctx: AppContext, filePath: string): string | null {
  const row = ctx.db
    .prepare("SELECT id FROM memories WHERE file_path = ? AND deleted_at IS NULL")
    .get(filePath) as { id: string } | undefined;
  if (!row) return null;
  ctx.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  // Drop derived artifacts so a deleted memory can't surface in retrieval.
  dropVectors(ctx, row.id);
  ctx.db.prepare("DELETE FROM sentences WHERE memory_id = ?").run(row.id);
  ctx.db.prepare("DELETE FROM chunks WHERE memory_id = ?").run(row.id);
  ctx.db.prepare("DELETE FROM facts WHERE memory_id = ?").run(row.id);
  deleteFts(ctx.db, row.id);
  oplog(ctx.db, "delete", { memory_id: row.id });
  return row.id;
}

/** Programmatic store (API/agents, Phase 4). Builds the path + frontmatter, writes, ingests. */
export async function storeMemory(
  ctx: AppContext,
  input: { namespace: string; project?: string | null; category?: string | null; source: string; title?: string; body: string; id?: string },
): Promise<IngestResult> {
  const id = input.id ?? ulid();
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id,
    source: input.source,
    namespace: input.namespace,
    created: now,
    updated: now,
  };
  if (input.project) fm.project = input.project;
  if (input.category) fm.category = input.category;
  if (input.title) fm.title = input.title;

  const filePath = scopeToPath(ctx.cfg.vaultPath, input, id);
  writeMemoryFile(ctx, filePath, fm, input.body);
  return (await ingestFile(ctx, filePath))!;
}

function scopeToPath(
  vault: string,
  input: { namespace: string; project?: string | null; category?: string | null },
  id: string,
): string {
  if (input.namespace === "nexus" && input.project) {
    const cat = capitalize(input.category ?? "memory");
    return join(vault, "Nexus", "Projects", input.project, cat, `${id}.md`);
  }
  if (input.namespace === "openclaw") return join(vault, "OpenClaw", "memory", `${id}.md`);
  return join(vault, "Memories", `${id}.md`);
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
