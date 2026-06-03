import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { syncTickets } from '../tickets/sync';

function freshDb() {
  const base = join(tmpdir(), `nexus-syncticket-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('syncTickets inserts new, updates existing, removes stale with replaceAll', () => {
  const { db, cleanup } = freshDb();

  const r1 = syncTickets(db, [
    { key: 'SUP-1', summary: 'one', status: 'Open' },
    { key: 'SUP-2', summary: 'two', status: 'Open' },
  ], { source: 'test', replaceAll: true });
  assert.deepEqual(r1, { inserted: 2, updated: 0, removed: 0 });

  const r2 = syncTickets(db, [
    { key: 'SUP-1', summary: 'one EDITED', status: 'Done' },
  ], { source: 'test', replaceAll: true });
  assert.deepEqual(r2, { inserted: 0, updated: 1, removed: 1 });

  const rows = db.prepare('SELECT key, summary FROM tickets ORDER BY key').all() as { key: string; summary: string }[];
  cleanup();
  assert.deepEqual(rows, [{ key: 'SUP-1', summary: 'one EDITED' }]);
});

test('syncTickets without replaceAll leaves stale rows', () => {
  const { db, cleanup } = freshDb();
  syncTickets(db, [{ key: 'SUP-1' }], { source: 'test', replaceAll: true });
  const r = syncTickets(db, [{ key: 'SUP-2' }], { source: 'test', replaceAll: false });
  const count = (db.prepare('SELECT COUNT(*) c FROM tickets').get() as { c: number }).c;
  cleanup();
  assert.deepEqual(r, { inserted: 1, updated: 0, removed: 0 });
  assert.equal(count, 2);
});

test('syncTickets skips entries without a key', () => {
  const { db, cleanup } = freshDb();
  const r = syncTickets(db, [{ summary: 'no key' } as any, { key: 'SUP-9' }], { source: 'test', replaceAll: false });
  cleanup();
  assert.deepEqual(r, { inserted: 1, updated: 0, removed: 0 });
});
