/**
 * DB access for the Monday mirror and the thread→item links.
 *
 * The two tables have deliberately different contracts. `monday_items` is
 * disposable and rebuildable from the API. `thread_monday_links` is user
 * intent and must survive a mirror wipe or a board reorganisation — which is
 * why pruning marks a linked row 'missing' instead of deleting it.
 *
 * Links point at chat threads since the session-first board (#439, D5): the
 * unit of work Nexus tracks is a session, so an item's roll-up is the state of
 * the sessions linked to it. `task_monday_links` remains only as a tombstone.
 */
import type Database from 'better-sqlite3';
import type { MondayItem, ThreadMondayLink, TaskStatus } from '@nexus/shared';
import { deriveLane, laneToTaskStatus } from '../board/lanes.js';
import { isRunning } from '../chat/run-registry.js';

const ITEM_COLUMNS = `item_id, board_id, board_name, group_id, group_title, name, state,
  status_label, status_color, owners_json, url, column_values_json, updates_json, monday_updated_at, synced_at`;

export function upsertItems(db: Database.Database, items: MondayItem[]): void {
  const stmt = db.prepare(`
    INSERT INTO monday_items (${ITEM_COLUMNS})
    VALUES (@item_id, @board_id, @board_name, @group_id, @group_title, @name, @state,
            @status_label, @status_color, @owners_json, @url, @column_values_json, @updates_json,
            @monday_updated_at, @synced_at)
    ON CONFLICT(item_id) DO UPDATE SET
      board_id = excluded.board_id,
      board_name = excluded.board_name,
      group_id = excluded.group_id,
      group_title = excluded.group_title,
      name = excluded.name,
      state = excluded.state,
      status_label = excluded.status_label,
      status_color = excluded.status_color,
      owners_json = excluded.owners_json,
      url = excluded.url,
      column_values_json = excluded.column_values_json,
      updates_json = excluded.updates_json,
      monday_updated_at = excluded.monday_updated_at,
      synced_at = excluded.synced_at
  `);
  const run = db.transaction((rows: MondayItem[]) => {
    // updates_json is optional on MondayItem (callers and fixtures predating
    // the field omit it), but a bound statement throws on a missing named
    // parameter — default it to match the column's own NOT NULL DEFAULT.
    for (const row of rows) stmt.run({ ...row, updates_json: row.updates_json ?? '[]' });
  });
  run(items);
}

/**
 * Mark the given item ids 'missing' in one transaction. Shared by pruneScope
 * (a linked row that vanished from a synced scope) and refreshLinkedItems in
 * sync.ts (a linked item Monday no longer returns for a direct id lookup) so
 * the two call sites cannot drift apart on the SQL or the atomicity: an id
 * with no matching row is simply a no-op UPDATE, so callers don't need to
 * pre-check existence. No-op for an empty list (`db.transaction` still opens
 * and closes an empty transaction otherwise).
 */
export function markItemsMissing(db: Database.Database, itemIds: string[], syncedAt: string): void {
  if (itemIds.length === 0) return;
  const markMissing = db.prepare("UPDATE monday_items SET state = 'missing', synced_at = ? WHERE item_id = ?");
  const run = db.transaction((ids: string[]) => {
    for (const id of ids) markMissing.run(syncedAt, id);
  });
  run(itemIds);
}

/**
 * Reconcile the mirror against what the board just returned. Confined to the
 * synced board (and group, when scoped) so other scopes are untouched.
 *
 * Linked rows are never deleted: they are marked 'missing' so a link to an
 * item someone archived in Monday degrades visibly instead of vanishing.
 * Returns the number of rows affected.
 */
export function pruneScope(
  db: Database.Database,
  boardId: string,
  groupId: string | null,
  keepItemIds: string[],
  syncedAt: string,
): number {
  const keep = new Set(keepItemIds);
  const scopeSql = groupId
    ? 'SELECT item_id FROM monday_items WHERE board_id = ? AND group_id = ?'
    : 'SELECT item_id FROM monday_items WHERE board_id = ?';
  const params = groupId ? [boardId, groupId] : [boardId];
  const present = (db.prepare(scopeSql).all(...params) as { item_id: string }[]).map((r) => r.item_id);
  const stale = present.filter((id) => !keep.has(id));
  if (stale.length === 0) return 0;

  const linked = new Set(
    (db.prepare(
      `SELECT DISTINCT item_id FROM thread_monday_links WHERE item_id IN (${stale.map(() => '?').join(',')})`,
    ).all(...stale) as { item_id: string }[]).map((r) => r.item_id),
  );

  const toMarkMissing = stale.filter((id) => linked.has(id));
  const toDelete = stale.filter((id) => !linked.has(id));
  const remove = db.prepare('DELETE FROM monday_items WHERE item_id = ?');

  // markItemsMissing opens its own db.transaction(); better-sqlite3 nests
  // that as a SAVEPOINT inside this outer one, so the delete and the
  // mark-missing stay one atomic unit exactly as before the extraction.
  const run = db.transaction(() => {
    for (const id of toDelete) remove.run(id);
    markItemsMissing(db, toMarkMissing, syncedAt);
  });
  run();
  return stale.length;
}

/**
 * Wipe the mirror. The maintenance action the trust panel offers beside the
 * memory-index rebuild: monday_items is disposable (Monday stays canonical
 * and the next view open or poll rebuilds it), while thread_monday_links is
 * user intent and is deliberately left alone — which is exactly why the two
 * are separate tables.
 */
export function clearMirror(db: Database.Database): number {
  return db.prepare('DELETE FROM monday_items').run().changes;
}

export function getItem(db: Database.Database, itemId: string): MondayItem | undefined {
  return db.prepare(`SELECT ${ITEM_COLUMNS} FROM monday_items WHERE item_id = ?`).get(itemId) as MondayItem | undefined;
}

export function listItemsForBoard(
  db: Database.Database,
  boardId: string,
  groupId: string | null,
): MondayItem[] {
  const sql = groupId
    ? `SELECT ${ITEM_COLUMNS} FROM monday_items WHERE board_id = ? AND group_id = ? ORDER BY name`
    : `SELECT ${ITEM_COLUMNS} FROM monday_items WHERE board_id = ? ORDER BY group_title, name`;
  const params = groupId ? [boardId, groupId] : [boardId];
  return db.prepare(sql).all(...params) as MondayItem[];
}

/** Upsert on thread_id: linking a thread that already has a link replaces it. */
export function linkThread(db: Database.Database, link: ThreadMondayLink): void {
  db.prepare(`
    INSERT INTO thread_monday_links (thread_id, item_id, project_id, created_at)
    VALUES (@thread_id, @item_id, @project_id, @created_at)
    ON CONFLICT(thread_id) DO UPDATE SET
      item_id = excluded.item_id,
      project_id = excluded.project_id,
      created_at = excluded.created_at
  `).run(link);
}

export function unlinkThread(db: Database.Database, threadId: string): void {
  db.prepare('DELETE FROM thread_monday_links WHERE thread_id = ?').run(threadId);
}

export function getLinkForThread(db: Database.Database, threadId: string): ThreadMondayLink | undefined {
  return db.prepare('SELECT thread_id, item_id, project_id, created_at FROM thread_monday_links WHERE thread_id = ?')
    .get(threadId) as ThreadMondayLink | undefined;
}

export function listLinksForProject(db: Database.Database, projectId: string): ThreadMondayLink[] {
  return db.prepare('SELECT thread_id, item_id, project_id, created_at FROM thread_monday_links WHERE project_id = ?')
    .all(projectId) as ThreadMondayLink[];
}

/** Every item id with at least one link, across all projects. Drives the poll. */
export function listLinkedItemIds(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT item_id FROM thread_monday_links').all() as { item_id: string }[])
    .map((r) => r.item_id);
}

/** A linked thread's archive state, the one fact the DB holds about its lane. */
interface LinkedThreadRow {
  id: string;
  archived_at: string | null;
}

/**
 * The legacy `TaskStatus` a thread projects onto (#439, D6): archived →
 * `deploy`, running → `in_progress`, otherwise `review`. The roll-up does not
 * distinguish Needs you from Running (both are "in progress" to Monday), so
 * pending questions and approvals are passed as zero here.
 */
export function threadTaskStatus(thread: { id: string; archived_at: string | null }): TaskStatus {
  return laneToTaskStatus(deriveLane({
    archived_at: thread.archived_at,
    running: isRunning(thread.id),
    pending_questions: 0,
    pending_approvals: 0,
  }));
}

/**
 * Statuses of every thread linked to an item — the roll-up's input. Derived
 * on read from `chat_threads.archived_at` and the in-memory run registry, so
 * the roll-up can never disagree with the board about a session's lane. A
 * link whose thread row is gone contributes nothing (the inner join drops it).
 */
export function listLinkedThreadStatuses(db: Database.Database, itemId: string): TaskStatus[] {
  const rows = db.prepare(`
    SELECT t.id AS id, t.archived_at AS archived_at
    FROM thread_monday_links l
    JOIN chat_threads t ON t.id = l.thread_id
    WHERE l.item_id = ?
  `).all(itemId) as LinkedThreadRow[];
  return rows.map(threadTaskStatus);
}
