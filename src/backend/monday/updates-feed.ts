/**
 * The item updates feed: Nexus's own notes on a Monday item's update thread.
 *
 * Two producers, one path. A linked session reaching Review (its run ended)
 * or Deploy (archived) posts a colleague-readable note (session titles, the
 * origin's URL when there is one); an agent calling
 * monday_post_update posts its own words with a provenance line. Both go
 * through the same per-item throttle and the same `monday_write` Activity
 * operation, so an agent cannot out-run the rate limit the automated path
 * respects (#260).
 *
 * Throttle: leading-edge with a trailing flush. The first event in a quiet
 * window posts at once; events inside the window queue and coalesce into a
 * single post at window end. Nothing is dropped. The window is the project's
 * `updates.min_interval_minutes` (floored to MIN_UPDATE_INTERVAL_MINUTES).
 *
 * State lives in the `monday_update_feed` table, not memory, so a backend
 * restart neither loses the queue nor forgets when it last posted — the
 * previous in-memory throttle was never wired up at all, which is why this
 * module exists.
 */
import type Database from 'better-sqlite3';
import type { MondayProjectConfig, Project } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from './poll.js';
import { getLinkForThread } from './store.js';
import { createUpdate, type MondayClientOptions, type MondayError } from './client.js';
import type { ActivityEvent } from '../activity/events.js';

/** Floor for the coalescing window. Mirrors the validator in routes/monday.ts. */
export const MIN_UPDATE_INTERVAL_MINUTES = 5;
const DEFAULT_INTERVAL_MINUTES = 30;
/** How often the trailing flush looks for due queues. */
const FLUSH_TICK_MS = 60_000;

export type FeedEvent =
  | { kind: 'moved'; thread_id: string; title: string; status: 'review' | 'deploy'; url: string | null; at: string }
  | { kind: 'note'; body: string; provenance: string; at: string };

/**
 * What a move is about: a session, its title, the stage it reached, and an
 * optional URL colleagues can open from Monday (the session's origin — a
 * GitHub issue, say — since a Nexus deep link is not reachable off the
 * tailnet). The caller resolves the URL; this module only renders it.
 */
export interface FeedMoveSubject {
  id: string;
  title: string;
  status: 'review' | 'deploy';
  url?: string | null;
}

export interface FeedDeps {
  postUpdate: typeof createUpdate;
}

const DEFAULT_DEPS: FeedDeps = { postUpdate: createUpdate };

type Emit = (event: ActivityEvent) => void;

interface FeedRow {
  item_id: string;
  project_id: string;
  last_posted_at: string | null;
  pending_json: string;
}

function projectMondayConfig(project: Project | undefined): MondayProjectConfig | null {
  if (!project) return null;
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

/** The window for a project, in ms. Reads the config field #260 found unread. */
export function feedWindowMs(cfg: MondayProjectConfig | null | undefined): number {
  const raw = Number(cfg?.updates?.min_interval_minutes);
  const minutes = Number.isFinite(raw) && raw > 0 ? Math.max(MIN_UPDATE_INTERVAL_MINUTES, raw) : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60_000;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pure: render a batch of events as one Monday update body (HTML).
 *
 * Moves are listed one session per line, latest state per session when one
 * moved twice inside the window, with the origin linked when there is one.
 * Agent notes follow, escaped, each with its provenance line — the same
 * "never let agent text render as markup" rule postItemUpdate enforces.
 */
export function formatFeedUpdate(events: FeedEvent[]): string {
  const latestMove = new Map<string, Extract<FeedEvent, { kind: 'moved' }>>();
  const notes: Extract<FeedEvent, { kind: 'note' }>[] = [];
  for (const e of events) {
    if (e.kind === 'moved') latestMove.set(e.thread_id, e);
    else notes.push(e);
  }

  const lines: string[] = [];
  if (latestMove.size > 0) {
    const n = latestMove.size;
    lines.push(`<b>Nexus</b> · ${n} session${n === 1 ? '' : 's'} moved`);
    for (const m of latestMove.values()) {
      const title = escapeHtml(m.title);
      const label = m.url ? `<a href="${escapeHtml(m.url)}">${title}</a>` : title;
      lines.push(`• ${label} → ${m.status === 'deploy' ? 'Done' : 'Review'}`);
    }
  }
  for (const note of notes) {
    if (lines.length > 0) lines.push('');
    lines.push(escapeHtml(note.body).replace(/\n/g, '<br>'));
    lines.push(`— posted by Nexus on behalf of ${escapeHtml(note.provenance)}`);
  }
  return lines.join('<br>');
}

function readRow(db: Database.Database, itemId: string): FeedRow | undefined {
  return db.prepare('SELECT * FROM monday_update_feed WHERE item_id = ?').get(itemId) as FeedRow | undefined;
}

function parsePending(row: FeedRow | undefined): FeedEvent[] {
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.pending_json || '[]');
    return Array.isArray(parsed) ? (parsed as FeedEvent[]) : [];
  } catch {
    return [];
  }
}

function writeRow(db: Database.Database, itemId: string, projectId: string, lastPostedAt: string | null, pending: FeedEvent[]): void {
  db.prepare(`
    INSERT INTO monday_update_feed (item_id, project_id, last_posted_at, pending_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET project_id = excluded.project_id,
      last_posted_at = excluded.last_posted_at, pending_json = excluded.pending_json
  `).run(itemId, projectId, lastPostedAt, JSON.stringify(pending));
}

function windowOpen(row: FeedRow | undefined, windowMs: number, now: number): boolean {
  if (!row?.last_posted_at) return true;
  const last = Date.parse(row.last_posted_at);
  return !Number.isFinite(last) || now - last >= windowMs;
}

/**
 * Post one batch, recording the outcome. On failure the events stay queued
 * (nothing is dropped) and the window restarts, so the next attempt is one
 * window later — a throttled retry rather than a tight loop, and the failed
 * `monday_write` operation is visible in the Activity Console.
 */
async function postBatch(
  db: Database.Database,
  opts: MondayClientOptions,
  itemId: string,
  projectId: string,
  events: FeedEvent[],
  now: number,
  deps: FeedDeps,
  emit?: Emit,
): Promise<'posted' | 'failed'> {
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  // The subject rides in the event's `taskId` slot (the ActivityEvent shape
  // predates the session-first board) and in `threadId` for deep-linking.
  const threadId = events.find((e): e is Extract<FeedEvent, { kind: 'moved' }> => e.kind === 'moved')?.thread_id ?? null;
  const taskId = threadId;
  emit?.({ type: 'start', operationId, kind: 'monday_write', title: 'Monday update', projectId, taskId, threadId, diagnostics: { itemId } });
  try {
    await deps.postUpdate(opts, itemId, formatFeedUpdate(events));
    writeRow(db, itemId, projectId, new Date(now).toISOString(), []);
    emit?.({
      type: 'stop', operationId, kind: 'monday_write', title: 'Monday update', projectId, taskId, threadId,
      status: 'succeeded', durationMs: Date.now() - startedAt, lastEvent: `${events.length} event(s) posted`,
    });
    return 'posted';
  } catch (err) {
    const monday = err as MondayError;
    writeRow(db, itemId, projectId, new Date(now).toISOString(), events);
    emit?.({
      type: 'stop', operationId, kind: 'monday_write', title: 'Monday update', projectId, taskId, threadId,
      status: 'failed', durationMs: Date.now() - startedAt, error: monday.message,
    });
    return 'failed';
  }
}

/**
 * Record an event for an item. Posts now when the item's window is open
 * (taking anything already queued with it, in order), otherwise queues it for
 * the trailing flush.
 */
export async function recordFeedEvent(
  db: Database.Database,
  opts: MondayClientOptions,
  projectId: string,
  cfg: MondayProjectConfig,
  itemId: string,
  event: FeedEvent,
  now: number = Date.now(),
  deps: FeedDeps = DEFAULT_DEPS,
  emit?: Emit,
): Promise<'posted' | 'queued' | 'failed'> {
  const row = readRow(db, itemId);
  const pending = parsePending(row);
  if (windowOpen(row, feedWindowMs(cfg), now)) {
    return postBatch(db, opts, itemId, projectId, [...pending, event], now, deps, emit);
  }
  writeRow(db, itemId, projectId, row?.last_posted_at ?? null, [...pending, event]);
  return 'queued';
}

/**
 * Trailing flush: post every queue whose window has elapsed. A project that
 * has since turned updates off has its queue dropped — the opt-out wins over
 * a note that was only ever waiting on the clock.
 */
export async function flushDueFeedUpdates(
  db: Database.Database,
  now: number = Date.now(),
  deps: FeedDeps = DEFAULT_DEPS,
  emit?: Emit,
): Promise<number> {
  const global = loadConfig().monday;
  const token = resolveMondayToken();
  if (!global.enabled || !token) return 0;
  const opts: MondayClientOptions = { token, apiVersion: global.api_version };

  const rows = db.prepare("SELECT * FROM monday_update_feed WHERE pending_json != '[]'").all() as FeedRow[];
  let posted = 0;
  for (const row of rows) {
    const pending = parsePending(row);
    if (pending.length === 0) continue;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) as Project | undefined;
    const cfg = projectMondayConfig(project);
    if (!cfg?.updates?.enabled) {
      writeRow(db, row.item_id, row.project_id, row.last_posted_at, []);
      continue;
    }
    if (!windowOpen(row, feedWindowMs(cfg), now)) continue;
    if ((await postBatch(db, opts, row.item_id, row.project_id, pending, now, deps, emit)) === 'posted') posted++;
  }
  return posted;
}

/**
 * Post one item's queue now, ignoring the window — the Activity Console's
 * Retry for a failed update. Returns 'nothing' when there is no queue.
 */
export async function flushFeedForItem(
  db: Database.Database,
  opts: MondayClientOptions,
  itemId: string,
  now: number = Date.now(),
  deps: FeedDeps = DEFAULT_DEPS,
  emit?: Emit,
): Promise<'posted' | 'failed' | 'nothing'> {
  const row = readRow(db, itemId);
  const pending = parsePending(row);
  if (!row || pending.length === 0) return 'nothing';
  return postBatch(db, opts, itemId, row.project_id, pending, now, deps, emit);
}

/** Start the trailing-flush timer. Returns a stop function. */
export function startUpdatesFeedFlush(db: Database.Database, emit?: Emit): () => void {
  if (!loadConfig().monday.enabled) return () => {};
  const handle = setInterval(() => {
    flushDueFeedUpdates(db, Date.now(), undefined, emit).catch((err) => {
      console.error('[monday] updates-feed flush failed unexpectedly:', (err as Error)?.message ?? err);
    });
  }, FLUSH_TICK_MS);
  return () => clearInterval(handle);
}

/**
 * Trigger for a session reaching Review (run ended) or Deploy (archived).
 * Fire-and-forget, the same contract as scheduleRollup: the lifecycle change
 * already happened, so nothing here may propagate. Silent no-op when the
 * thread is unlinked, the project has not opted in, or Monday is off.
 */
export async function scheduleFeedMove(
  db: Database.Database,
  subject: FeedMoveSubject,
  emit?: Emit,
  deps: FeedDeps = DEFAULT_DEPS,
  now: number = Date.now(),
): Promise<'posted' | 'queued' | 'failed' | 'skipped'> {
  try {
    if (subject.status !== 'review' && subject.status !== 'deploy') return 'skipped';
    const global = loadConfig().monday;
    const token = resolveMondayToken();
    if (!global.enabled || !token) return 'skipped';
    const link = getLinkForThread(db, subject.id);
    if (!link) return 'skipped';
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(link.project_id) as Project | undefined;
    const cfg = projectMondayConfig(project);
    if (!cfg?.updates?.enabled) return 'skipped';
    const event: FeedEvent = {
      kind: 'moved', thread_id: subject.id, title: subject.title, status: subject.status,
      url: subject.url ?? null, at: new Date(now).toISOString(),
    };
    return await recordFeedEvent(
      db, { token, apiVersion: global.api_version }, link.project_id, cfg, link.item_id, event, now, deps, emit,
    );
  } catch (err) {
    console.error('[monday] scheduleFeedMove failed unexpectedly:', (err as Error)?.message ?? err);
    return 'skipped';
  }
}

/**
 * The agent path: monday_post_update. Same throttle, same operation. Returns
 * whether the note went out now or is waiting for the window, so the tool can
 * tell the model the truth.
 */
export async function scheduleFeedNote(
  db: Database.Database,
  opts: MondayClientOptions,
  projectId: string,
  cfg: MondayProjectConfig,
  itemId: string,
  body: string,
  provenance: string,
  emit?: Emit,
  deps: FeedDeps = DEFAULT_DEPS,
  now: number = Date.now(),
): Promise<'posted' | 'queued'> {
  const event: FeedEvent = { kind: 'note', body, provenance, at: new Date(now).toISOString() };
  const result = await recordFeedEvent(db, opts, projectId, cfg, itemId, event, now, deps, emit);
  // A failed post is still queued (nothing dropped) and retries at the next
  // window, so from the model's point of view it is "queued", not lost.
  return result === 'posted' ? 'posted' : 'queued';
}

/** The emitter the agent path uses: set once at startup, since tool deps are
 *  built per thread without access to the ActivityManager. */
let feedEmit: Emit | undefined;
export function setUpdatesFeedEmitter(emit: Emit | undefined): void {
  feedEmit = emit;
}
export function updatesFeedEmitter(): Emit | undefined {
  return feedEmit;
}
