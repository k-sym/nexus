import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
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
  assert.ok(itemCols.includes('updates_json'));
  assert.ok(itemCols.includes('synced_at'));

  const linkCols = (db.pragma('table_info(task_monday_links)') as { name: string }[]).map((c) => c.name);
  assert.deepEqual(linkCols.sort(), ['created_at', 'item_id', 'project_id', 'task_id']);
  db.close();
});

test('migrates an existing monday_items table (predating updates_json) by adding the column', () => {
  // Regression coverage for the note in db.ts: this must apply cleanly to a
  // real EXISTING database that already has monday_items WITHOUT the new
  // column — not only to a fresh :memory: one, which would pass even if the
  // guarded ALTER were wired to the wrong table or column name.
  const base = join(tmpdir(), `nexus-monday-updates-migration-${process.pid}-${Date.now()}.db`);
  const oldDb = new Database(base);
  oldDb.exec(`
    CREATE TABLE monday_items (
      item_id            TEXT PRIMARY KEY,
      board_id           TEXT NOT NULL,
      board_name         TEXT NOT NULL DEFAULT '',
      group_id           TEXT,
      group_title        TEXT,
      name               TEXT NOT NULL DEFAULT '',
      state              TEXT NOT NULL DEFAULT 'active',
      status_label       TEXT,
      status_color       TEXT,
      owners_json        TEXT NOT NULL DEFAULT '[]',
      url                TEXT,
      column_values_json TEXT NOT NULL DEFAULT '{}',
      monday_updated_at  TEXT,
      synced_at          TEXT NOT NULL
    );
  `);
  oldDb.prepare(`
    INSERT INTO monday_items (item_id, board_id, board_name, name, state, synced_at)
    VALUES ('900', 'b1', 'Portfolio', 'Pre-existing item', 'active', '2026-07-01T00:00:00.000Z')
  `).run();
  oldDb.close();

  const db = getDb(base); // runs runMigrations() against the existing file
  const cols = (db.pragma('table_info(monday_items)') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('updates_json'), 'updates_json column added to the existing table');

  // Existing row backfilled with the column default, not NULL — matches the
  // fresh-table DEFAULT '[]' so recentUpdates() sees the same shape either way.
  const row = db.prepare('SELECT updates_json FROM monday_items WHERE item_id = ?').get('900') as { updates_json: string };
  assert.equal(row.updates_json, '[]', 'pre-existing row backfilled with the default, not NULL');

  // The migration is idempotent: reopening the now-migrated file must not
  // throw ("duplicate column") on the guarded ALTER re-running.
  db.close();
  assert.doesNotThrow(() => {
    const reopened = getDb(base);
    reopened.close();
  });

  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
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
