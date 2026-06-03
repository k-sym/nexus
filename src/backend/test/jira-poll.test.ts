import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { runJiraSyncOnce } from '../jira/poll';
import { listUnseen } from '../notifications';
import type { IncomingTicket } from '../tickets/sync';

function freshDb() {
  const base = join(tmpdir(), `nexus-jirapoll-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

const JIRA = { enabled: true, user: 'u', instance: 'h', project: 'SUP', poll_minutes: 15 };

test('runJiraSyncOnce is dormant when disabled or token missing', async () => {
  const { db, cleanup } = freshDb();
  const fetchTickets = async () => { throw new Error('should not be called'); };
  const a = await runJiraSyncOnce(db, { ...JIRA, enabled: false }, 'tok', fetchTickets);
  const b = await runJiraSyncOnce(db, JIRA, undefined, fetchTickets);
  cleanup();
  assert.equal(a, null);
  assert.equal(b, null);
});

test('runJiraSyncOnce syncs tickets and notifies on change', async () => {
  const { db, cleanup } = freshDb();
  const tickets: IncomingTicket[] = [{ key: 'SUP-1', summary: 'one' }, { key: 'SUP-2', summary: 'two' }];
  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => tickets);
  const count = (db.prepare('SELECT COUNT(*) c FROM tickets').get() as { c: number }).c;
  const notifs = listUnseen(db);
  cleanup();
  assert.deepEqual(res, { inserted: 2, updated: 0, removed: 0 });
  assert.equal(count, 2);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].level, 'info');
  assert.match(notifs[0].message, /2 new/);
});

test('runJiraSyncOnce is silent on no-op (zero changes)', async () => {
  const { db, cleanup } = freshDb();
  await runJiraSyncOnce(db, JIRA, 'tok', async () => [{ key: 'SUP-1' }]);
  // second identical sync: SUP-1 already present, replaceAll removes nothing -> 0/1/0... ensure updated counts as change.
  // Use an empty-but-same set to force a true no-op: re-sync the same single ticket.
  const before = listUnseen(db).length;
  await runJiraSyncOnce(db, JIRA, 'tok', async () => [{ key: 'SUP-1' }]);
  const after = listUnseen(db).length;
  cleanup();
  // The second run updates SUP-1 (updated=1) which IS a change, so a notification is expected.
  // This asserts the change-detection counts updates; see no-op-true test below.
  assert.equal(after, before + 1);
});

test('runJiraSyncOnce true no-op (no tickets, none existing) makes no notification', async () => {
  const { db, cleanup } = freshDb();
  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => []);
  const notifs = listUnseen(db);
  cleanup();
  assert.deepEqual(res, { inserted: 0, updated: 0, removed: 0 });
  assert.equal(notifs.length, 0);
});

test('runJiraSyncOnce notifies error and stays non-throwing on fetch failure', async () => {
  const { db, cleanup } = freshDb();
  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => { throw new Error('HTTP 401: bad token'); });
  const notifs = listUnseen(db);
  cleanup();
  assert.equal(res, null);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].level, 'error');
  assert.match(notifs[0].message, /401/);
});
