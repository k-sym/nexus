/**
 * DB access for the Monday mirror and the task→item links.
 *
 * The two tables have deliberately different contracts. `monday_items` is
 * disposable and rebuildable from the API. `task_monday_links` is user intent
 * and must survive a mirror wipe or a board reorganisation — which is why
 * pruning marks a linked row 'missing' instead of deleting it.
 */
import type Database from 'better-sqlite3';
import type { MondayItem, TaskMondayLink, TaskStatus } from '@nexus/shared';

const ITEM_COLUMNS = `item_id, board_id, board_name, group_id, group_title, name, state,
  status_label, status_color, owners_json, url, column_values_json, monday_updated_at, synced_at`;

export function upsertItems(db: Database.Database, items: MondayItem[]): void {
  const stmt = db.prepare(`
    INSERT INTO monday_items (${ITEM_COLUMNS})
    VALUES (@item_id, @board_id, @board_name, @group_id, @group_title, @name, @state,
            @status_label, @status_color, @owners_json, @url, @column_values_json,
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
      monday_updated_at = excluded.monday_updated_at,
      synced_at = excluded.synced_at
  `);
  const run = db.transaction((rows: MondayItem[]) => {
    for (const row of rows) stmt.run(row);
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
      `SELECT DISTINCT item_id FROM task_monday_links WHERE item_id IN (${stale.map(() => '?').join(',')})`,
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

/** Upsert on task_id: linking a task that already has a link replaces it. */
export function linkTask(db: Database.Database, link: TaskMondayLink): void {
  db.prepare(`
    INSERT INTO task_monday_links (task_id, item_id, project_id, created_at)
    VALUES (@task_id, @item_id, @project_id, @created_at)
    ON CONFLICT(task_id) DO UPDATE SET
      item_id = excluded.item_id,
      project_id = excluded.project_id,
      created_at = excluded.created_at
  `).run(link);
}

export function unlinkTask(db: Database.Database, taskId: string): void {
  db.prepare('DELETE FROM task_monday_links WHERE task_id = ?').run(taskId);
}

export function getLinkForTask(db: Database.Database, taskId: string): TaskMondayLink | undefined {
  return db.prepare('SELECT task_id, item_id, project_id, created_at FROM task_monday_links WHERE task_id = ?')
    .get(taskId) as TaskMondayLink | undefined;
}

export function listLinksForProject(db: Database.Database, projectId: string): TaskMondayLink[] {
  return db.prepare('SELECT task_id, item_id, project_id, created_at FROM task_monday_links WHERE project_id = ?')
    .all(projectId) as TaskMondayLink[];
}

/** Every item id with at least one link, across all projects. Drives the poll. */
export function listLinkedItemIds(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT item_id FROM task_monday_links').all() as { item_id: string }[])
    .map((r) => r.item_id);
}

/** Statuses of every task linked to an item — the roll-up's input. */
export function listLinkedTaskStatuses(db: Database.Database, itemId: string): TaskStatus[] {
  return (db.prepare(`
    SELECT t.status AS status
    FROM task_monday_links l
    JOIN tasks t ON t.id = l.task_id
    WHERE l.item_id = ?
  `).all(itemId) as { status: TaskStatus }[]).map((r) => r.status);
}
