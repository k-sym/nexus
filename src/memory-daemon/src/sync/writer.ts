// The ONLY programmatic writer of vault markdown.
// Records the written content hash in sync_state BEFORE the file lands so the watcher
// recognizes its own write as an echo and does not re-index it (loop suppression).
import { mkdirSync, renameSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../context.js";
import { contentHash } from "./hash.js";
import { serializeMarkdown } from "./identity.js";

export interface WriteResult {
  serialized: string;
  hash: string;
  mtime: number;
}

/**
 * Atomically write a memory's markdown file. Caller passes the full frontmatter
 * (which must already include `id`) and body.
 */
export function writeMemoryFile(
  ctx: AppContext,
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): WriteResult {
  const serialized = serializeMarkdown(frontmatter, body);
  const hash = contentHash(serialized);

  // 1) Pre-register the echo BEFORE touching disk so a fast watcher event is suppressed.
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO sync_state (file_path, memory_id, last_written_hash, last_indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         memory_id = excluded.memory_id,
         last_written_hash = excluded.last_written_hash,
         last_indexed_at = excluded.last_indexed_at`,
    )
    .run(filePath, (frontmatter.id as string) ?? null, hash, now);

  ctx.inflight.add(filePath);

  // 2) Atomic write: temp file in the same dir + rename.
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, serialized, "utf8");
  renameSync(tmp, filePath);

  const mtime = Math.floor(statSync(filePath).mtimeMs);
  ctx.db.prepare("UPDATE sync_state SET last_mtime = ? WHERE file_path = ?").run(mtime, filePath);

  // 3) Release the in-flight guard after the watcher debounce window has elapsed.
  setTimeout(() => ctx.inflight.delete(filePath), 1500);

  return { serialized, hash, mtime };
}
