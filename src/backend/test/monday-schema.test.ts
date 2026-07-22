import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getDb } from '../db';

function tempDb() {
  return getDb(':memory:');
}

test('monday_items and task_monday_links tables exist with expected columns', () => {
  const db: Database.Database = tempDb();
  const itemCols = (db.pragma('table_info(monday_items)') as { name: string }[]).map((c) => c.name);
  assert.ok(itemCols.includes('item_id'));
  assert.ok(itemCols.includes('board_id'));
  assert.ok(itemCols.includes('group_id'));
  assert.ok(itemCols.includes('state'));
  assert.ok(itemCols.includes('status_label'));
  assert.ok(itemCols.includes('column_values_json'));
  assert.ok(itemCols.includes('synced_at'));

  const linkCols = (db.pragma('table_info(task_monday_links)') as { name: string }[]).map((c) => c.name);
  assert.deepEqual(linkCols.sort(), ['created_at', 'item_id', 'project_id', 'task_id']);
  db.close();
});

test('task_monday_links enforces one item per task', () => {
  const db = tempDb();
  db.prepare('INSERT INTO task_monday_links (task_id, item_id, project_id, created_at) VALUES (?, ?, ?, ?)')
    .run('task-1', 'item-1', 'proj-1', '2026-07-22T00:00:00.000Z');
  assert.throws(
    () => db.prepare('INSERT INTO task_monday_links (task_id, item_id, project_id, created_at) VALUES (?, ?, ?, ?)')
      .run('task-1', 'item-2', 'proj-1', '2026-07-22T00:00:00.000Z'),
    /UNIQUE constraint failed/,
  );
  db.close();
});

test('monday indexes are created', () => {
  const db = tempDb();
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
    .map((r) => r.name);
  assert.ok(names.includes('idx_monday_items_board'));
  assert.ok(names.includes('idx_task_monday_links_item'));
  assert.ok(names.includes('idx_task_monday_links_project'));
  db.close();
});
