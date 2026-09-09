/**
 * The single funnel every write trigger goes through: a session's run ending,
 * a session being archived, link, unlink (see thread-hooks.ts and
 * routes/monday.ts for the call sites).
 *
 * Two rules matter here. A write failure never propagates to the caller — the
 * lifecycle change already happened locally and the operation is retryable
 * from the Activity Console. And a write that fails because the configured column
 * no longer exists in Monday self-disables roll-up for that project after one
 * notification, rather than failing on every future move forever.
 */
import type Database from 'better-sqlite3';
import type { MondayProjectConfig, Project } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from './poll.js';
import { getLinkForThread } from './store.js';
import { writeRollup, type RollupWriteDeps } from './writes.js';
import { writeStatus, type StatusWriteDeps } from './status-sync.js';
import { MondayError, type MondayClientOptions } from './client.js';
import { insertNotification } from '../notifications/index.js';
import type { ActivityEvent } from '../activity/events.js';

/** Error codes that mean the configuration is wrong, not that Monday is busy. */
const CONFIG_ERROR_CODES = new Set(['ColumnValueException', 'InvalidColumnIdException']);

function projectMondayConfig(project: Project | undefined): MondayProjectConfig | null {
  if (!project) return null;
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

/** Turn roll-up off for a project, leaving every other setting intact. */
export function disableRollupForProject(db: Database.Database, projectId: string, reason: string): void {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) return;
  const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
  // Idempotent: no monday config, no rollup sub-key (a legacy config blob that
  // predates it), or roll-up already disabled — nothing left to do. Without
  // this, two run-end hooks racing against the same project's configuration
  // error would each reach this function and each insert a notification.
  if (!parsed.monday?.rollup?.enabled) return;
  parsed.monday.rollup.enabled = false;
  db.prepare('UPDATE projects SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(parsed), new Date().toISOString(), projectId);
  insertNotification(db, {
    level: 'error',
    title: 'Monday roll-up disabled',
    message: `${reason}. Re-select a roll-up column in the project's Monday settings to turn it back on.`,
  });
}

/** Turn status sync off for a project, leaving every other setting intact.
 *  Same idempotent shape as disableRollupForProject: a racing pair of run-end
 *  hooks that both hit a stale-label write must not each insert a notification. */
export function disableStatusSyncForProject(db: Database.Database, projectId: string, reason: string): void {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) return;
  const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
  if (!parsed.monday?.status_sync?.enabled) return;
  parsed.monday.status_sync.enabled = false;
  db.prepare('UPDATE projects SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(parsed), new Date().toISOString(), projectId);
  insertNotification(db, {
    level: 'error',
    title: 'Monday status sync disabled',
    message: `${reason}. Re-check the status mapping in the project's Monday settings to turn it back on.`,
  });
}

/**
 * Roll up a specific item. The item-addressed form, needed by unlink — where
 * the link is already gone by the time we recompute.
 */
export async function scheduleRollupForItem(
  db: Database.Database,
  itemId: string,
  projectId: string,
  threadId: string | null,
  emit?: (event: ActivityEvent) => void,
  deps?: RollupWriteDeps,
): Promise<void> {
  // Everything in this function — including the lookups before the write
  // itself — is wrapped in one outer try/catch. This is fire-and-forget from
  // a run end, archive, link, or unlink that has already committed: nothing here,
  // not even an unexpected DB error unrelated to Monday (e.g. a caller whose
  // schema predates the Monday tables), may propagate out and fail that
  // caller. The inner try/catch below additionally distinguishes a
  // configuration error (self-disable) from a transient one (retry later).
  try {
    const cfg = loadConfig().monday;
    const token = resolveMondayToken();
    if (!cfg.enabled || !token) return;

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    const projectCfg = projectMondayConfig(project);
    // Optional chain deliberately, same as session-deps.ts's `cfg.updates?.enabled`:
    // there is currently no UI that writes this config, so a hand-written
    // partial `monday` block with a `board_id` but no `rollup` sub-key at all
    // is real, reachable input, not a programmer error. `.rollup.enabled`
    // would throw on it — caught by the outer try/catch below, but mislogged
    // as "failed unexpectedly" instead of degrading to "roll-up not enabled".
    if (!projectCfg || !projectCfg.rollup?.enabled || !projectCfg.rollup?.column_id) return;

    const opts: MondayClientOptions = { token, apiVersion: cfg.api_version };
    const operationId = crypto.randomUUID();
    const startedAt = Date.now();
    // diagnostics.itemId is what POST /api/activity/:id/retry needs to re-run
    // this write: the unlink site has no thread to look it up from. The
    // subject travels in the event's `taskId` slot — the ActivityEvent shape
    // predates the session-first board and the console keys on it — and in
    // `threadId` so the console can deep-link the session.
    emit?.({ type: 'start', operationId, kind: 'monday_write', title: 'Monday roll-up', projectId, taskId: threadId, threadId, diagnostics: { itemId } });

    try {
      const result = await writeRollup(db, opts, projectCfg, itemId, deps);
      emit?.({
        type: 'stop', operationId, kind: 'monday_write', title: 'Monday roll-up',
        projectId, taskId: threadId, threadId, status: 'succeeded', durationMs: Date.now() - startedAt, lastEvent: result,
      });
    } catch (err) {
      const monday = err as MondayError;
      emit?.({
        type: 'stop', operationId, kind: 'monday_write', title: 'Monday roll-up',
        projectId, taskId: threadId, threadId, status: 'failed', durationMs: Date.now() - startedAt, error: monday.message,
      });
      // A missing column is a configuration problem: retrying it on every future
      // run end would fail forever and bury the Activity Console.
      if (monday.code && CONFIG_ERROR_CODES.has(monday.code)) {
        disableRollupForProject(db, projectId, `Monday rejected the roll-up column: ${monday.message}`);
      }
    }
  } catch (err) {
    console.error('[monday] scheduleRollupForItem failed unexpectedly:', (err as Error)?.message ?? err);
  }
}

/** Roll up whatever item this thread is linked to. Silent no-op when unlinked. */
export async function scheduleRollup(
  db: Database.Database,
  threadId: string,
  _event: string | null,
  emit?: (event: ActivityEvent) => void,
  deps?: RollupWriteDeps,
): Promise<void> {
  try {
    const link = getLinkForThread(db, threadId);
    if (!link) return;
    await scheduleRollupForItem(db, link.item_id, link.project_id, threadId, emit, deps);
  } catch (err) {
    console.error('[monday] scheduleRollup failed unexpectedly:', (err as Error)?.message ?? err);
  }
}

/**
 * Push a specific item's status from its linked sessions' aggregate stage. The
 * item-addressed form, mirroring scheduleRollupForItem: fire-and-forget, one
 * outer try/catch so nothing here can fail the already-committed caller, and a
 * configuration error (bad column/label) self-disables status sync after one
 * notification rather than failing on every future move.
 *
 * `allowAdvanceFromUnmanaged` is the ownership handoff: only the link-create
 * call sites (the link route and the board's Go) pass true, letting the first
 * sync advance an item off the human-owned inbox label. Every other trigger
 * passes false, so a status a human set outside the mapping is left untouched.
 */
export async function scheduleStatusSyncForItem(
  db: Database.Database,
  itemId: string,
  projectId: string,
  threadId: string | null,
  allowAdvanceFromUnmanaged: boolean,
  emit?: (event: ActivityEvent) => void,
  deps?: StatusWriteDeps,
): Promise<void> {
  try {
    const cfg = loadConfig().monday;
    const token = resolveMondayToken();
    if (!cfg.enabled || !token) return;

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    const projectCfg = projectMondayConfig(project);
    if (!projectCfg || !projectCfg.status_sync?.enabled || !projectCfg.status_sync?.column_id) return;

    const opts: MondayClientOptions = { token, apiVersion: cfg.api_version };
    const operationId = crypto.randomUUID();
    const startedAt = Date.now();
    emit?.({ type: 'start', operationId, kind: 'monday_write', title: 'Monday status', projectId, taskId: threadId, threadId, diagnostics: { itemId } });

    try {
      const result = await writeStatus(db, opts, projectCfg, itemId, deps, { allowAdvanceFromUnmanaged });
      emit?.({
        type: 'stop', operationId, kind: 'monday_write', title: 'Monday status',
        projectId, taskId: threadId, threadId, status: 'succeeded', durationMs: Date.now() - startedAt, lastEvent: result,
      });
    } catch (err) {
      const monday = err as MondayError;
      emit?.({
        type: 'stop', operationId, kind: 'monday_write', title: 'Monday status',
        projectId, taskId: threadId, threadId, status: 'failed', durationMs: Date.now() - startedAt, error: monday.message,
      });
      // A missing column or a label the column no longer has (e.g. renamed on
      // Monday, leaving the mapping stale) is a configuration problem: retrying
      // it on every future run end would fail forever and bury the Activity Console.
      if (monday.code && CONFIG_ERROR_CODES.has(monday.code)) {
        disableStatusSyncForProject(db, projectId, `Monday rejected the status write: ${monday.message}`);
      }
    }
  } catch (err) {
    console.error('[monday] scheduleStatusSyncForItem failed unexpectedly:', (err as Error)?.message ?? err);
  }
}

/** Sync the status of whatever item this thread is linked to. Silent no-op
 *  when unlinked. `allowAdvanceFromUnmanaged` true only from the link-create sites. */
export async function scheduleStatusSync(
  db: Database.Database,
  threadId: string,
  _event: string | null,
  allowAdvanceFromUnmanaged: boolean,
  emit?: (event: ActivityEvent) => void,
  deps?: StatusWriteDeps,
): Promise<void> {
  try {
    const link = getLinkForThread(db, threadId);
    if (!link) return;
    await scheduleStatusSyncForItem(db, link.item_id, link.project_id, threadId, allowAdvanceFromUnmanaged, emit, deps);
  } catch (err) {
    console.error('[monday] scheduleStatusSync failed unexpectedly:', (err as Error)?.message ?? err);
  }
}
