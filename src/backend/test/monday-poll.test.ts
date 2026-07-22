// A live MONDAY_TOKEN in the dev shell would make the "unconfigured" cases
// pass for the wrong reason — exactly what happened with JIRA_TOKEN.
delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import { runMondayRefreshOnce, resolveMondayToken, __resetPollErrorState } from '../monday/poll';
import { MondayError } from '../monday/client';
import type { ActivityEvent } from '../activity/events';

const CFG = { enabled: true, api_version: '2024-10', poll_minutes: 10 };

test('resolveMondayToken reads MONDAY_TOKEN only', () => {
  assert.equal(resolveMondayToken(), undefined);
  process.env.MONDAY_TOKEN = 'from-env';
  assert.equal(resolveMondayToken(), 'from-env');
  delete process.env.MONDAY_TOKEN;
});

test('the refresh is dormant when disabled', async () => {
  const db = getDb(':memory:');
  let called = false;
  const result = await runMondayRefreshOnce(db, { ...CFG, enabled: false }, 'tok', async () => { called = true; return 1; });
  assert.equal(result, null);
  assert.equal(called, false);
  db.close();
});

test('the refresh is dormant with no token', async () => {
  const db = getDb(':memory:');
  let called = false;
  const result = await runMondayRefreshOnce(db, CFG, undefined, async () => { called = true; return 1; });
  assert.equal(result, null);
  assert.equal(called, false);
  db.close();
});

test('a successful refresh emits start and succeeded', async () => {
  const db = getDb(':memory:');
  const events: ActivityEvent[] = [];
  const result = await runMondayRefreshOnce(db, CFG, 'tok', async () => 3, (e) => events.push(e));
  assert.equal(result, 3);
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].kind, 'monday_sync');
  assert.equal(events.at(-1)!.status, 'succeeded');
  db.close();
});

test('a failed refresh emits failed, records a notification, and never throws', async () => {
  const db = getDb(':memory:');
  const events: ActivityEvent[] = [];
  const result = await runMondayRefreshOnce(db, CFG, 'tok', async () => {
    throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
  }, (e) => events.push(e));
  assert.equal(result, null);
  assert.equal(events.at(-1)!.status, 'failed');
  assert.match(events.at(-1)!.error ?? '', /Not Authenticated/);
  const notes = db.prepare('SELECT title, message FROM notifications').all() as { title: string; message: string }[];
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /Not Authenticated/);
  db.close();
});

test('an identical repeat failure does not notify twice', async () => {
  // lastErrorMessage is process-level (see poll.ts), so the previous test's
  // failure would otherwise leak in here and make this test's own first call
  // look like a repeat. Reset before asserting fresh dedup behaviour.
  __resetPollErrorState();
  const db = getDb(':memory:');
  const fail = async () => { throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200); };
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  assert.equal(count, 1);
  db.close();
});
