// Full reindex from the vault. This is the core "the index is disposable" promise:
// delete the SQLite file (or not) and call reindexAll() to reconstruct the index
// from the canonical markdown.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../context.js";
import { oplog } from "../db/index.js";
import { ingestFile, removeFile } from "./ingest.js";
import { ensureVaultMarker, vaultReady } from "./marker.js";

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

/** Readiness for the missing-file pass: the marker's bytes are readable (see marker.ts).
 *  A vault indexed before markers existed has no marker yet; if the walk already finds
 *  markdown, the tree is evidently there — stamp it now so every later boot has the
 *  strong signal. Directory existence alone is never trusted (File Provider lists
 *  folders before their contents are hydrated). */
function vaultPresent(vaultPath: string): boolean {
  if (vaultReady(vaultPath)) return true;
  if (walkMarkdown(vaultPath).length > 0) {
    ensureVaultMarker(vaultPath);
    return vaultReady(vaultPath);
  }
  return false;
}

function liveCount(ctx: AppContext): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL").get() as { n: number }).n;
}

/**
 * Boot gate. A fresh install gets its vault directory created and stamped. A populated
 * index whose vault is not ready (marker unreadable, no markdown found) is NOT a vault
 * that was emptied — it is a vault that is not there yet (Dropbox / File Provider still
 * mounting or hydrating at login, a wrong path, a move in progress), so wait for it
 * instead of creating an empty tree over the mount point. Returns false when the wait
 * timed out; reindexAll() then keeps the index intact.
 */
export async function waitForVault(
  ctx: AppContext,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollMs = options.pollMs ?? 5_000;
  if (liveCount(ctx) === 0) {
    ensureVaultMarker(ctx.cfg.vaultPath);
    return true;
  }
  const start = Date.now();
  let warned = false;
  while (!vaultPresent(ctx.cfg.vaultPath)) {
    if (Date.now() - start >= timeoutMs) {
      console.error(`[nexus-memory] vault ${ctx.cfg.vaultPath} still not ready after ${Math.round(timeoutMs / 1000)}s (no readable .nexus-vault marker, no markdown) — starting anyway, index left intact`);
      return false;
    }
    if (!warned) {
      console.error(`[nexus-memory] vault ${ctx.cfg.vaultPath} is not ready but the index holds ${liveCount(ctx)} memories — waiting for it to mount`);
      warned = true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
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

  // Soft-delete memories whose backing file is gone — unless the vault is not ready
  // (marker unreadable and nothing found; see marker.ts), which is an unmounted or
  // half-hydrated folder, not a deleted library. Never turn a mount race into hundreds
  // of soft-deletes. A ready vault with pages removed is a real edit and is honoured.
  const live = ctx.db
    .prepare("SELECT id, file_path FROM memories WHERE deleted_at IS NULL")
    .all() as Array<{ id: string; file_path: string }>;
  if (live.length > 0 && !vaultPresent(ctx.cfg.vaultPath)) {
    console.error(`[nexus-memory] reindex: vault ${ctx.cfg.vaultPath} not ready but ${live.length} live memories — skipping the missing-file pass`);
    oplog(ctx.db, "reindex", { detail: JSON.stringify({ ...stats, skippedRemoval: live.length }) });
    return stats;
  }
  for (const row of live) {
    if (!existsSync(row.file_path)) {
      if (removeFile(ctx, row.file_path)) stats.removed++;
    }
  }

  oplog(ctx.db, "reindex", { detail: JSON.stringify(stats) });
  return stats;
}
