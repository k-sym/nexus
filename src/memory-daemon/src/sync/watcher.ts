// Vault file watcher. Human edits are not expected (read-only by discipline), but the
// watcher is kept as cheap insurance: external edits are picked up, last-writer-wins,
// logged to oplog. It must never react to the daemon's own writes (loop suppression).
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync } from "node:fs";
import type { AppContext } from "../context.js";
import { contentHash } from "./hash.js";
import { ingestFile, removeFile } from "./ingest.js";

const DEBOUNCE_MS = 300;

function isIndexable(p: string): boolean {
  if (!p.endsWith(".md")) return false;
  if (p.includes("/.index/") || p.includes("/.git/")) return false;
  if (p.includes(".tmp-")) return false;
  return true;
}

/** Is this on-disk content already represented in the index (echo / duplicate event)? */
function isEcho(ctx: AppContext, filePath: string): boolean {
  if (ctx.inflight.has(filePath)) return true;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const hash = contentHash(raw);
  const ss = ctx.db
    .prepare("SELECT last_written_hash FROM sync_state WHERE file_path = ?")
    .get(filePath) as { last_written_hash: string | null } | undefined;
  if (ss?.last_written_hash === hash) return true;
  const mem = ctx.db
    .prepare("SELECT content_hash FROM memories WHERE file_path = ? AND deleted_at IS NULL")
    .get(filePath) as { content_hash: string } | undefined;
  return mem?.content_hash === hash;
}

export function startWatcher(ctx: AppContext): FSWatcher {
  const timers = new Map<string, NodeJS.Timeout>();

  const schedule = (filePath: string, fn: () => void | Promise<void>) => {
    const prev = timers.get(filePath);
    if (prev) clearTimeout(prev);
    timers.set(
      filePath,
      setTimeout(() => {
        timers.delete(filePath);
        Promise.resolve()
          .then(fn)
          .catch((err) => console.error(`[watcher] ${filePath}: ${(err as Error).message}`));
      }, DEBOUNCE_MS),
    );
  };

  const watcher = chokidar.watch(ctx.cfg.vaultPath, {
    ignoreInitial: true, // boot does a full reindex; the watcher handles deltas only
    ignored: (p: string) => p.includes("/.index/") || p.includes("/.git/"),
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const onUpsert = (filePath: string) => {
    if (!isIndexable(filePath)) return;
    schedule(filePath, async () => {
      if (isEcho(ctx, filePath)) return;
      const res = await ingestFile(ctx, filePath);
      if (res && res.action !== "noop") console.log(`[watcher] ${res.action} ${filePath}`);
    });
  };

  watcher
    .on("add", onUpsert)
    .on("change", onUpsert)
    .on("unlink", (filePath) => {
      if (!isIndexable(filePath)) return;
      schedule(filePath, () => {
        const id = removeFile(ctx, filePath);
        if (id) console.log(`[watcher] delete ${filePath}`);
      });
    });

  console.log(`[watcher] watching ${ctx.cfg.vaultPath}`);
  return watcher;
}
