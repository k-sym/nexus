/**
 * Scheduler loop.
 *
 * Checks every 60s for schedules whose next_run is due, creates a task in
 * "in_progress" (so the orchestrator dispatches it), then recomputes next_run
 * from the cron expression. Backfills next_run for schedules on startup.
 */
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { Schedule } from '@nexus/shared';
import { getNextRun } from './cron';

const CHECK_INTERVAL_MS = 60_000;

export function startScheduler(db: Database.Database) {
  console.log('[scheduler] Starting...');

  // Calculate next_run for any schedules missing it on startup.
  backfillNextRuns(db);

  setInterval(() => {
    try {
      checkAndDispatch(db);
    } catch (err) {
      console.error('[scheduler] Check error:', err);
    }
  }, CHECK_INTERVAL_MS);

  // Run an immediate check on startup.
  checkAndDispatch(db);
}

function backfillNextRuns(db: Database.Database) {
  const schedules = db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NULL').all() as Schedule[];
  for (const sched of schedules) {
    const next = getNextRun(sched.cron_expr);
    if (next) {
      db.prepare('UPDATE schedules SET next_run = ? WHERE id = ?').run(next.toISOString(), sched.id);
    }
  }
}

function checkAndDispatch(db: Database.Database) {
  const now = new Date().toISOString();

  const due = db.prepare(
    'SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?'
  ).all(now) as Schedule[];

  for (const sched of due) {
    try {
      dispatchScheduledTask(db, sched);

      const next = getNextRun(sched.cron_expr);
      db.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?')
        .run(now, next ? next.toISOString() : null, sched.id);

      console.log(`[scheduler] Dispatched "${sched.name}", next run: ${next?.toISOString() || 'none'}`);
    } catch (err) {
      console.error(`[scheduler] Failed to dispatch schedule ${sched.id}:`, err);
    }
  }
}

function dispatchScheduledTask(db: Database.Database, sched: Schedule) {
  const now = new Date().toISOString();
  const taskId = uuid();

  // Create a task straight into "in_progress" so the orchestrator picks it up.
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_agent, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_progress', 'medium', ?, NULL, ?, ?)`
  ).run(
    taskId,
    sched.project_id,
    sched.task_template,
    sched.task_description || `Scheduled task: ${sched.name}`,
    sched.agent_id,
    now,
    now,
  );

  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, sched.project_id);
}
