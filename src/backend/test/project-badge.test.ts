import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { deriveProjectBadge, normalizeProjectBadge } from '@nexus/shared';
import { getDb } from '../db';

test('deriveProjectBadge takes initials from multi-word names, ignoring connectors', () => {
  assert.equal(deriveProjectBadge('United States of America'), 'USA');
  assert.equal(deriveProjectBadge('Brooklyn Roasters'), 'BR');
  assert.equal(deriveProjectBadge('Nexus Agent Orchestration Platform'), 'NAO');
});

test('deriveProjectBadge takes the first three letters of a single word', () => {
  assert.equal(deriveProjectBadge('Nexus'), 'NEX');
  assert.equal(deriveProjectBadge('go'), 'GO');
});

test('deriveProjectBadge keeps connectors when nothing else survives', () => {
  // "of the" would otherwise filter down to nothing and return '?'.
  assert.equal(deriveProjectBadge('of the'), 'OT');
});

test('deriveProjectBadge falls back for names with no alphanumerics', () => {
  assert.equal(deriveProjectBadge('!!!'), '?');
  assert.equal(deriveProjectBadge(''), '?');
});

test('normalizeProjectBadge strips punctuation, uppercases and caps length', () => {
  assert.equal(normalizeProjectBadge('a-b/c d', 'Fallback Name'), 'ABC');
  assert.equal(normalizeProjectBadge('brk', 'Fallback Name'), 'BRK');
});

test('normalizeProjectBadge falls back to the derived badge when input is empty', () => {
  assert.equal(normalizeProjectBadge('', 'Brooklyn Roasters'), 'BR');
  assert.equal(normalizeProjectBadge('   ', 'Nexus'), 'NEX');
  assert.equal(normalizeProjectBadge(undefined, 'Nexus'), 'NEX');
});

test('migrates a pre-badge projects table and backfills badges from the name', () => {
  const base = join(tmpdir(), `nexus-badge-migration-${process.pid}-${Date.now()}.db`);
  const oldDb = new Database(base);
  // The shape a real pre-#230 database has: no badge column.
  oldDb.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      git_remote TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = oldDb.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('p1', 'nexus', 'Nexus', '/tmp/nexus', 'now', 'now');
  insert.run('p2', 'brooklyn-roasters', 'Brooklyn Roasters', '/tmp/br', 'now', 'now');
  oldDb.close();

  const db = getDb(base);
  const cols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  const rows = db.prepare('SELECT id, badge FROM projects ORDER BY id').all() as { id: string; badge: string }[];
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });

  assert.ok(cols.includes('badge'), 'badge column added');
  assert.deepEqual(rows, [
    { id: 'p1', badge: 'NEX' },
    { id: 'p2', badge: 'BR' },
  ]);
});

test('a freshly created projects table already has the badge column', () => {
  const base = join(tmpdir(), `nexus-badge-fresh-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(cols.includes('badge'), 'badge column present on a new database');
});
