// Ghost-job recovery: a crash can leave jobs stuck in PROCESSING. On boot, reset them
// to PENDING so the worker picks them up again. (At-least-once; job handlers are idempotent.)
import type { DB } from "../db/index.js";

export function recoverGhostJobs(db: DB): number {
  const res = db
    .prepare("UPDATE jobs SET status = 'PENDING', updated_at = ? WHERE status = 'PROCESSING'")
    .run(new Date().toISOString());
  return res.changes;
}
