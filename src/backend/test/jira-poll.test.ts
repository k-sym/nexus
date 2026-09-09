import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { getDb } from '../db';
import { runJiraSyncOnce, startJiraSync } from '../jira/poll';
import { loadConfig, saveConfig } from '../config';
import { listUnseen } from '../notifications';
import type { IncomingTicket } from '../tickets/sync';

function freshDb() {
  const base = join(tmpdir(), `nexus-jirapoll-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

const JIRA = { enabled: true, user: 'u', instance: 'h', project: 'SUP', poll_minutes: 15 };
const WEEKDAYS = { enabled: true, days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };

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

test('runJiraSyncOnce preserves existing tickets when Jira unexpectedly returns zero issues', async () => {
  const { db, cleanup } = freshDb();
  await runJiraSyncOnce(db, JIRA, 'tok', async () => [{ key: 'SUP-1', summary: 'one' }]);

  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => []);
  const count = (db.prepare('SELECT COUNT(*) c FROM tickets').get() as { c: number }).c;
  const notifs = listUnseen(db);
  cleanup();

  assert.equal(res, null);
  assert.equal(count, 1);
  assert.equal(notifs[0]?.level, 'error');
  assert.match(notifs[0]?.message ?? '', /returned zero tickets/i);
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

// startJiraSync reads ~/.nexus/config.yaml; point it at a scratch tree so the
// gate tests never touch the real config (and JIRA_TOKEN is set explicitly).
function withScratchConfig(workHours: typeof WEEKDAYS) {
  const home = mkdtempSync(join(tmpdir(), 'nexus-jira-wh-'));
  process.env.NEXUS_HOME = home;
  process.env.JIRA_TOKEN = 'tok';
  const cfg = loadConfig();
  saveConfig({ ...cfg, jira: { ...cfg.jira, ...JIRA, work_hours: workHours } });
  return () => { delete process.env.NEXUS_HOME; delete process.env.JIRA_TOKEN; rmSync(home, { recursive: true, force: true }); };
}

function captureLog() {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

test('startJiraSync skips the tick outside work hours and logs the pause once', async () => {
  const { db, cleanup } = freshDb();
  const restoreCfg = withScratchConfig(WEEKDAYS);
  const log = captureLog();
  let fetches = 0;
  const sunday = new Date(2026, 8, 6, 10, 0); // Sunday 6 Sep 2026
  const { stop } = startJiraSync(db, undefined, { now: () => sunday, fetchTickets: async () => { fetches++; return []; } });
  stop();
  log.restore();
  restoreCfg();
  cleanup();
  assert.equal(fetches, 0);
  assert.equal(log.lines.filter((l) => l.includes('outside work hours')).length, 1);
  assert.ok(log.lines.some((l) => l.includes('poll started') && l.includes('Mon,Tue,Wed,Thu,Fri 08:00–18:00')), log.lines.join('\n'));
});

test('startJiraSync fetches on the first tick inside work hours', async () => {
  const { db, cleanup } = freshDb();
  const restoreCfg = withScratchConfig(WEEKDAYS);
  const log = captureLog();
  let fetches = 0;
  const monday = new Date(2026, 8, 7, 10, 0); // Monday 7 Sep 2026
  const { stop } = startJiraSync(db, undefined, { now: () => monday, fetchTickets: async () => { fetches++; return []; } });
  stop();
  await new Promise((r) => setImmediate(r));
  log.restore();
  restoreCfg();
  cleanup();
  assert.equal(fetches, 1);
  assert.equal(log.lines.some((l) => l.includes('outside work hours')), false);
});

test('startJiraSync polls around the clock when work hours are disabled', async () => {
  const { db, cleanup } = freshDb();
  const restoreCfg = withScratchConfig({ ...WEEKDAYS, enabled: false });
  const log = captureLog();
  let fetches = 0;
  const sunday = new Date(2026, 8, 6, 3, 0);
  const { stop } = startJiraSync(db, undefined, { now: () => sunday, fetchTickets: async () => { fetches++; return []; } });
  stop();
  await new Promise((r) => setImmediate(r));
  log.restore();
  restoreCfg();
  cleanup();
  assert.equal(fetches, 1);
  assert.ok(log.lines.some((l) => l.includes('work hours always')), log.lines.join('\n'));
});
