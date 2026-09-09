/**
 * Where Monday learns about a session's lifecycle (#439, D7).
 *
 * Before the session-first board, the task PUT in routes/projects.ts was the
 * one place a Kanban move reached the roll-up, status sync and updates feed.
 * Sessions have no PUT: their state is a run starting or stopping (the run
 * registry), an archive (routes/chat.ts) or a link being made (routes/monday.ts
 * and the board's Go). This module is the seam between those three sources
 * and monday/trigger.ts + monday/updates-feed.ts, so the chat stream never has
 * to know Monday exists.
 *
 * Every hook is fire-and-forget and never throws: the lifecycle change has
 * already happened, and a Monday fault is the Activity Console's business.
 * Threads with no link cost one indexed lookup and nothing else.
 */
import type Database from 'better-sqlite3';
import { onRunChange } from '../chat/run-registry.js';
import type { ActivityEvent } from '../activity/events.js';
import { getLinkForThread } from './store.js';
import { scheduleRollup, scheduleStatusSync } from './trigger.js';
import type { RollupWriteDeps } from './writes.js';
import type { StatusWriteDeps } from './status-sync.js';
import { scheduleFeedMove, type FeedDeps } from './updates-feed.js';

type Emit = (event: ActivityEvent) => void;

/** Injection seams for tests; production callers pass nothing. */
export interface ThreadHookDeps {
  rollup?: RollupWriteDeps;
  status?: StatusWriteDeps;
  feed?: FeedDeps;
}

function threadTitle(db: Database.Database, threadId: string): string {
  try {
    const row = db.prepare('SELECT title FROM chat_threads WHERE id = ?').get(threadId) as { title: string } | undefined;
    return row?.title ?? threadId;
  } catch {
    return threadId;
  }
}

/**
 * Roll-up, status sync (no advance off a human-held label) and a feed move to
 * the given stage, for one linked thread. The shared body of the run-end and
 * archive hooks; `review` is "the agent has stopped, look at it", `deploy` is
 * "archived, done".
 */
function fireLifecycle(
  db: Database.Database,
  threadId: string,
  event: string,
  stage: 'review' | 'deploy',
  emit: Emit | undefined,
  deps: ThreadHookDeps,
): void {
  try {
    if (!getLinkForThread(db, threadId)) return;
    void scheduleRollup(db, threadId, event, emit, deps.rollup);
    void scheduleStatusSync(db, threadId, event, false, emit, deps.status);
    void scheduleFeedMove(db, { id: threadId, title: threadTitle(db, threadId), status: stage }, emit, deps.feed);
  } catch (err) {
    console.error(`[monday] thread hook (${event}) failed unexpectedly:`, (err as Error)?.message ?? err);
  }
}

/**
 * Subscribe to the run registry. A run STOPPING for a linked thread is the
 * session-first equivalent of a card landing in Review: the item's roll-up
 * and status are recomputed and the updates feed gets a `review` move. Run
 * starts are deliberately ignored — the roll-up would only flip the same
 * session between review and in_progress on every turn, and the feed would
 * narrate noise. Returns the unsubscribe function for index.ts's shutdown.
 */
export function registerMondayThreadHooks(db: Database.Database, emit?: Emit, deps: ThreadHookDeps = {}): () => void {
  return onRunChange((threadId, running) => {
    if (running) return;
    fireLifecycle(db, threadId, 'run ended', 'review', emit, deps);
  });
}

/** The archive route's hook: the same three writes with a `deploy` move. */
export function onThreadArchived(db: Database.Database, threadId: string, emit?: Emit, deps: ThreadHookDeps = {}): void {
  fireLifecycle(db, threadId, 'thread archived', 'deploy', emit, deps);
}

/**
 * A link was just created (POST /api/monday/links, or the board's Go for a
 * Monday item). Roll-up plus status sync with `allowAdvanceFromUnmanaged`
 * true: linking is the ownership handoff that may move an item off the
 * human-owned inbox label, as the link route always has. No feed move — the
 * session has not reached a stage yet.
 */
export function onThreadLinked(db: Database.Database, threadId: string, emit?: Emit, deps: ThreadHookDeps = {}): void {
  try {
    void scheduleRollup(db, threadId, 'thread linked', emit, deps.rollup);
    void scheduleStatusSync(db, threadId, 'thread linked', true, emit, deps.status);
  } catch (err) {
    console.error('[monday] thread hook (thread linked) failed unexpectedly:', (err as Error)?.message ?? err);
  }
}
