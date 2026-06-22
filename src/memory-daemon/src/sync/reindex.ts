// Full reindex from the vault. This is the core "the index is disposable" promise:
// delete the SQLite file (or not) and call reindexAll() to reconstruct the index
// from the canonical markdown.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../context.js";
import { oplog } from "../db/index.js";
import { ingestFile, removeFile } from "./ingest.js";

function walkMarkdown(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".index" || e.name === ".git" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.isFile() && e.name.endsWith(".md") && !e.name.includes(".tmp-")) out.push(full);
  }
  return out;
}

export interface ReindexStats {
  scanned: number;
  inserted: number;
  updated: number;
  noop: number;
  removed: number;
  reindexed: number;
  queued: number;
}

export async function reindexAll(
  ctx: AppContext,
  options: { force?: boolean } = {},
): Promise<ReindexStats> {
  const stats: ReindexStats = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    noop: 0,
    removed: 0,
    reindexed: 0,
    queued: 0,
  };
  const files = walkMarkdown(ctx.cfg.vaultPath);

  for (const f of files) {
    const res = await ingestFile(ctx, f, options);
    stats.scanned++;
    if (!res) continue;
    stats[res.action === "insert" ? "inserted" : res.action === "update" ? "updated" : "noop"]++;
    if (res.action !== "noop") stats.queued++;
    if (options.force && res.action !== "insert") stats.reindexed++;
  }

  // Soft-delete memories whose backing file is gone.
  const live = ctx.db
    .prepare("SELECT id, file_path FROM memories WHERE deleted_at IS NULL")
    .all() as Array<{ id: string; file_path: string }>;
  for (const row of live) {
    if (!existsSync(row.file_path)) {
      if (removeFile(ctx, row.file_path)) stats.removed++;
    }
  }

  oplog(ctx.db, "reindex", { detail: JSON.stringify(stats) });
  return stats;
}
