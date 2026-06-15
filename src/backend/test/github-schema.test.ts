import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getDb } from '../db';

function freshDb(tag: string) {
  const base = join(tmpdir(), `nexus-ghschema-${tag}-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('projects has a git_remote column', () => {
  const { db, cleanup } = freshDb('proj');
  const cols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  cleanup();
  assert.ok(cols.includes('git_remote'), 'git_remote column present on projects');
});

test('tasks has external_source and external_id columns', () => {
  const { db, cleanup } = freshDb('task');
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  cleanup();
  assert.ok(cols.includes('external_source'), 'external_source column present on tasks');
  assert.ok(cols.includes('external_id'), 'external_id column present on tasks');
});

test('migrates a pre-existing projects table missing git_remote', () => {
  const base = join(tmpdir(), `nexus-ghschema-old-${process.pid}-${Date.now()}.db`);
  const old = new Database(base);
  old.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      description TEXT DEFAULT '', repo_path TEXT NOT NULL, config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium', assigned_agent TEXT, due_date TEXT,
      thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  old.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('p1', 'p1', 'P1', '/tmp', 'now', 'now');
  old.close();

  const db = getDb(base);
  const projCols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  const taskCols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  const row = db.prepare('SELECT git_remote FROM projects WHERE id = ?').get('p1') as { git_remote: string };
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });

  assert.ok(projCols.includes('git_remote'), 'git_remote added to existing projects table');
  assert.ok(taskCols.includes('external_source') && taskCols.includes('external_id'), 'external cols added to existing tasks table');
  assert.equal(row.git_remote, '', 'existing project rows default git_remote to empty string');
});
