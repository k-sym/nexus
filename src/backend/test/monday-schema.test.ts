import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { getDb } from '../db';

function tempDb() {
  return getDb(':memory:');
}

/**
 * A database file in the state a user's real one is in before this migration
 * runs: fully migrated by every earlier step, with `monday_items` present but
 * without the column being added.
 *
 * Built by opening a real database and DROPping the column back off, rather
 * than by hand-writing the old CREATE TABLE here. A hand-copied DDL is a
 * second definition of the schema that silently drifts from db.ts; dropping
 * the column off the genuine article cannot drift, and it exercises the case
 * that actually matters — reopening an existing FILE, not a fresh :memory:
 * one, which is where the "no such column" incident this convention guards
 * against happened.
 */
function preMigrationDbFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-monday-migration-'));
  const path = join(dir, 'nexus.db');
  getDb(path).close();
  const raw = new Database(path);
  raw.exec('ALTER TABLE monday_items DROP COLUMN updates_json');
  raw.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LEGACY_ROW_SQL = `
  INSERT INTO monday_items (item_id, board_id, board_name, group_id, group_title, name, state,
    status_label, status_color, owners_json, url, column_values_json, monday_updated_at, synced_at)
  VALUES ('9', 'b1', 'Portfolio', NULL, NULL, 'Written before the migration', 'active',
    'Working on it', NULL, '[]', NULL, '{}', NULL, '2026-07-01T00:00:00.000Z')
`;

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

test('a fresh database has monday_items.updates_json', () => {
  const db = tempDb();
  const cols = (db.pragma('table_info(monday_items)') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('updates_json'), 'updates_json must exist on a fresh database');
  db.close();
});

test('opening an existing database without updates_json migrates it and keeps its rows', () => {
  const { path, cleanup } = preMigrationDbFile();
  try {
    const before = new Database(path);
    const beforeCols = (before.pragma('table_info(monday_items)') as { name: string }[]).map((c) => c.name);
    assert.ok(!beforeCols.includes('updates_json'), 'fixture must start without the column');
    before.exec(LEGACY_ROW_SQL);
    before.close();

    const db = getDb(path);
    const cols = (db.pragma('table_info(monday_items)') as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('updates_json'), 'the guarded ALTER must add the column to an existing database');

    // The pre-existing row survives and reads back through the column, rather
    // than being dropped by a table rebuild or left NULL for callers that
    // JSON.parse it.
    const row = db.prepare('SELECT name, updates_json FROM monday_items WHERE item_id = ?').get('9') as
      { name: string; updates_json: string };
    assert.equal(row.name, 'Written before the migration');
    assert.equal(row.updates_json, '[]');
    db.close();
  } finally {
    cleanup();
  }
});

test('the updates_json migration is idempotent across repeated opens', () => {
  const { path, cleanup } = preMigrationDbFile();
  try {
    getDb(path).close();
    // Second open takes the guard's other branch: the column already exists,
    // so re-running the ALTER would throw "duplicate column name".
    const db = getDb(path);
    const cols = (db.pragma('table_info(monday_items)') as { name: string }[])
      .filter((c) => c.name === 'updates_json');
    assert.equal(cols.length, 1);
    db.close();
  } finally {
    cleanup();
  }
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
