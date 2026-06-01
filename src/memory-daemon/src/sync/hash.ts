// Hashing primitives.
//  - contentHash: strong (sha256) — used for loop/echo suppression and change detection.
//  - fnv1a: fast 32-bit — used for per-segment embedding dedup (Phase 3).
import { createHash } from "node:crypto";

export function contentHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps it in uint32 range)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
