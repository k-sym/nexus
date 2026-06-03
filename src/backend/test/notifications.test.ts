import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { insertNotification, listUnseen, markSeen } from '../notifications';

function freshDb() {
  const base = join(tmpdir(), `nexus-notiftest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('notifications table exists with expected columns', () => {
  const { db, cleanup } = freshDb();
  const cols = (db.pragma('table_info(notifications)') as { name: string }[]).map(c => c.name);
  cleanup();
  for (const c of ['id', 'level', 'title', 'message', 'created_at', 'seen_at']) {
    assert.ok(cols.includes(c), `${c} column present`);
  }
});

test('insertNotification + listUnseen + markSeen lifecycle', () => {
  const { db, cleanup } = freshDb();

  const id1 = insertNotification(db, { level: 'info', title: 'Jira', message: '2 new' });
  insertNotification(db, { level: 'error', title: 'Jira sync failed', message: 'HTTP 401' });

  let unseen = listUnseen(db);
  assert.equal(unseen.length, 2);
  assert.equal(unseen[0].level, 'error'); // most recent first

  markSeen(db, [id1]);
  unseen = listUnseen(db);
  cleanup();
  assert.equal(unseen.length, 1);
  assert.equal(unseen[0].title, 'Jira sync failed');
});
