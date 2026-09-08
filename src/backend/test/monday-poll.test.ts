// A live MONDAY_TOKEN in the dev shell would make the "unconfigured" cases
// pass for the wrong reason — exactly what happened with JIRA_TOKEN.
delete process.env.MONDAY_TOKEN;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getDb } from '../db';
import { runMondayRefreshOnce, resolveMondayToken, __resetPollErrorState, withinWorkHours, describeWorkHours } from '../monday/poll';
import { MondayError } from '../monday/client';
import type { ActivityEvent } from '../activity/events';

const CFG = { enabled: true, api_version: '2024-10', poll_minutes: 10 };

// lastErrorMessage is module-level, so without this a value set by one test
// suppresses a notification in the next. Reset before each test to verify
// fresh dedup behaviour independent of test ordering.
beforeEach(() => __resetPollErrorState());

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
  const db = getDb(':memory:');
  const fail = async () => { throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200); };
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  assert.equal(count, 1);
  db.close();
});

test('a different error message notifies again', async () => {
  const db = getDb(':memory:');
  const fail1 = async () => { throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200); };
  const fail2 = async () => { throw new MondayError('Rate limited', 'RateLimitException', 429); };
  await runMondayRefreshOnce(db, CFG, 'tok', fail1);
  await runMondayRefreshOnce(db, CFG, 'tok', fail2);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  assert.equal(count, 2);
  db.close();
});

test('success resets dedup state so recurrence of prior error notifies again', async () => {
  const db = getDb(':memory:');
  const fail = async () => { throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200); };
  const succeed = async () => 5;
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  await runMondayRefreshOnce(db, CFG, 'tok', succeed);
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  assert.equal(count, 2);
  db.close();
});

test('a failed refresh never throws even when recording the failure notification itself fails', async () => {
  // runMondayRefreshOnce's documented contract is "never throws" — it runs on
  // an unawaited setInterval tick in startMondayPoll. insertNotification was
  // called inside the catch block unguarded, so a DB error there (a locked
  // file, a schema that predates the notifications table, etc.) would escape
  // past the very catch block meant to contain the ORIGINAL failure. A bare
  // Database with no schema at all reproduces that: the notifications table
  // doesn't exist, so insertNotification's INSERT throws.
  const bareDb = new Database(':memory:');
  const events: ActivityEvent[] = [];
  const result = await runMondayRefreshOnce(bareDb, CFG, 'tok', async () => {
    throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
  }, (e) => events.push(e));
  // Still resolves (doesn't reject), still reports the original failure via
  // the activity event and a null return — the notification-recording
  // failure is swallowed, not the refresh failure itself.
  assert.equal(result, null);
  assert.equal(events.at(-1)!.status, 'failed');
  bareDb.close();
});

test('resolveMondayToken treats whitespace-only value as absent', () => {
  process.env.MONDAY_TOKEN = '   ';
  assert.equal(resolveMondayToken(), undefined);
  delete process.env.MONDAY_TOKEN;
});

// --- work hours -------------------------------------------------------------


const WEEKDAYS = { enabled: true, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
// 2026-09-07 is a Monday; 2026-09-06 a Sunday.
const monday = (h: number, m = 0) => new Date(2026, 8, 7, h, m);
const sunday = (h: number) => new Date(2026, 8, 6, h, 0);

test('withinWorkHours is inclusive of start and exclusive of end', () => {
  assert.equal(withinWorkHours(WEEKDAYS, monday(7, 59)), false);
  assert.equal(withinWorkHours(WEEKDAYS, monday(8, 0)), true);
  assert.equal(withinWorkHours(WEEKDAYS, monday(12)), true);
  assert.equal(withinWorkHours(WEEKDAYS, monday(17, 59)), true);
  assert.equal(withinWorkHours(WEEKDAYS, monday(18, 0)), false);
});

test('withinWorkHours excludes days not listed', () => {
  assert.equal(withinWorkHours(WEEKDAYS, sunday(12)), false);
  assert.equal(withinWorkHours({ ...WEEKDAYS, days: [0] }, sunday(12)), true);
});

test('withinWorkHours is always-on when disabled, missing, or malformed', () => {
  assert.equal(withinWorkHours(undefined, sunday(3)), true);
  assert.equal(withinWorkHours({ ...WEEKDAYS, enabled: false }, sunday(3)), true);
  // A typo must not silently switch the poll off for good.
  assert.equal(withinWorkHours({ ...WEEKDAYS, start: 'nine' }, sunday(3)), true);
  assert.equal(withinWorkHours({ ...WEEKDAYS, start: '18:00', end: '08:00' }, sunday(3)), true);
  assert.equal(withinWorkHours({ ...WEEKDAYS, days: [] }, sunday(3)), true);
});

test('describeWorkHours summarises the window for the log line', () => {
  assert.equal(describeWorkHours(WEEKDAYS), 'Mon,Tue,Wed,Thu,Fri 08:00–18:00');
  assert.equal(describeWorkHours({ ...WEEKDAYS, enabled: false }), 'always');
  assert.equal(describeWorkHours(undefined), 'always');
});
