// SQLite-backed job queue: enqueue, atomic claim, complete, and fail-with-backoff
// (-> DEAD after max_attempts). Single in-process worker, so claims can't race.
import type { DB } from "../db/index.js";

export type JobType = "deep_index" | "extract_kg" | "reindex_memory";

export interface Job {
  id: number;
  type: JobType;
  payload: string;
  attempts: number;
  max_attempts: number;
}

export function enqueue(db: DB, type: JobType, payload: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
     VALUES (?, ?, 'PENDING', 0, 5, ?, ?, ?)`,
  ).run(type, JSON.stringify(payload), now, now, now);
}

/** Atomically claim the next runnable job (PENDING and past its backoff gate). */
export function claim(db: DB): Job | null {
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `UPDATE jobs SET status = 'PROCESSING', updated_at = ?
       WHERE id = (
         SELECT id FROM jobs WHERE status = 'PENDING' AND run_after <= ?
         ORDER BY id LIMIT 1
       )
       RETURNING id, type, payload, attempts, max_attempts`,
    )
    .get(now, now) as Job | undefined;
  return row ?? null;
}

export function complete(db: DB, id: number): void {
  db.prepare("UPDATE jobs SET status = 'DONE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

/** Record a failure: retry with exponential backoff, or move to DEAD after max_attempts. */
export function fail(db: DB, job: Job, err: string): "retry" | "dead" {
  const attempts = job.attempts + 1;
  const now = Date.now();
  if (attempts >= job.max_attempts) {
    db.prepare("UPDATE jobs SET status = 'DEAD', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?").run(
      attempts,
      err,
      new Date(now).toISOString(),
      job.id,
    );
    return "dead";
  }
  const backoffMs = Math.min(2 ** attempts * 1000, 60_000); // 2s,4s,8s,16s,… capped 60s
  db.prepare(
    "UPDATE jobs SET status = 'PENDING', attempts = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?",
  ).run(attempts, err, new Date(now + backoffMs).toISOString(), new Date(now).toISOString(), job.id);
  return "retry";
}
