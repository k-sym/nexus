import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import {
  runAttentionPollOnce, startAttentionPoll, readCursor, writeCursor, pushFor, __resetPollErrorState,
  type AttentionPollDeps,
} from '../attention/poll';
import type { PartnerClient } from '../partner/client';
import type { PushMessage } from '../apns/sender';

const item = (id: string, alertSeq: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'mail.waiting',
  status: 'open',
  title: `Re: thread ${id}`,
  why: 'waiting 2d from someone@example.com',
  proposed_verb: 'draft',
  alert_seq: alertSeq,
  ...extra,
});

interface Harness {
  deps: AttentionPollDeps;
  pushes: PushMessage[];
  logs: string[];
  listCalls: number;
}

function harness(opts: {
  list?: () => unknown | Promise<unknown>;
  partner?: boolean;
  apnsConfigured?: boolean;
  push?: boolean;
  approvals?: number;
} = {}): Harness {
  const pushes: PushMessage[] = [];
  const logs: string[] = [];
  const h: Harness = { pushes, logs, listCalls: 0, deps: undefined as any };
  const partner = {
    async listAttention() {
      h.listCalls += 1;
      return opts.list ? opts.list() : { items: [], open: 0, seq: 0, alert_seq: 0 };
    },
  } as unknown as PartnerClient;
  h.deps = {
    partner: () => (opts.partner === false ? undefined : partner),
    apns: {
      get configured() { return opts.apnsConfigured ?? true; },
      async notify(message) { pushes.push(message); },
    },
    pendingApprovals: () => opts.approvals ?? 0,
    config: () => ({ push: opts.push ?? true, poll_minutes: 1 }),
    log: (line) => logs.push(line),
  };
  return h;
}

beforeEach(() => __resetPollErrorState());

test('the cursor table round-trips one row', () => {
  const db = getDb(':memory:');
  assert.equal(readCursor(db), null);
  writeCursor(db, 4);
  writeCursor(db, 9);
  assert.equal(readCursor(db), 9);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM attention_push_cursor').get() as { c: number }).c, 1);
  db.close();
});

test('a fresh database seeds the cursor silently and pushes nothing', async () => {
  const db = getDb(':memory:');
  const h = harness({ list: () => ({ items: [item('a', 3), item('b', 4)], open: 2, seq: 10, alert_seq: 4 }) });
  const tick = await runAttentionPollOnce(db, h.deps);
  assert.deepEqual(tick, { seeded: true, pushed: 0, open: 2, cursor: 4 });
  assert.equal(readCursor(db), 4);
  assert.equal(h.pushes.length, 0);
  assert.match(h.logs[0], /seeded at alert_seq 4/);
  db.close();
});

test('the poller lists open items only', async () => {
  const db = getDb(':memory:');
  let status: unknown;
  const partner = { async listAttention(s: unknown) { status = s; return { items: [], open: 0, seq: 0, alert_seq: 0 }; } } as unknown as PartnerClient;
  const h = harness();
  await runAttentionPollOnce(db, { ...h.deps, partner: () => partner });
  assert.equal(status, 'open');
  db.close();
});

test('an item whose alert_seq moved past the cursor gets exactly one push, badge = open + approvals', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 4);
  const h = harness({
    approvals: 2,
    list: () => ({ items: [item('old', 3), item('new', 5)], open: 2, seq: 12, alert_seq: 5 }),
  });
  const tick = await runAttentionPollOnce(db, h.deps);
  assert.deepEqual(tick, { seeded: false, pushed: 1, open: 2, cursor: 5 });
  assert.equal(h.pushes.length, 1);
  const push = h.pushes[0];
  assert.equal(push.deepLink, 'attention:new');
  assert.equal(push.threadId, 'attention:mail.waiting');
  assert.equal(push.badge, 4);
  assert.equal(push.title, 'Needs you — Mail waiting');
  assert.equal(push.body, 'Draft? Re: thread new · waiting 2d from someone@example.com');
  assert.equal(readCursor(db), 5);

  // The next tick with nothing new pushes nothing again.
  await runAttentionPollOnce(db, h.deps);
  assert.equal(h.pushes.length, 1);
  db.close();
});

test('a renotify of the same item is a second push', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 5);
  const h = harness({ list: () => ({ items: [item('meet', 6, { kind: 'meeting.prep' })], open: 1, seq: 20, alert_seq: 6 }) });
  await runAttentionPollOnce(db, h.deps);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].title, 'Needs you — Meeting prep');
  db.close();
});

test('push text falls back gracefully without why or a known kind and clips at 120 chars', () => {
  const plain = pushFor({ id: 'x', kind: 'future.kind', title: 'Something', alert_seq: 1 }, 0);
  assert.equal(plain.title, 'Needs you — future.kind');
  assert.equal(plain.body, 'Something');
  const long = pushFor({ id: 'x', kind: 'mail.urgent', title: 'T'.repeat(200), why: 'w', proposed_verb: 'open', alert_seq: 1 }, 0);
  assert.equal(long.body.length, 120);
  assert.ok(long.body.startsWith('Open? TTT'));
});

test('an unreachable partner pushes nothing, leaves the cursor, and logs once until the message changes', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 4);
  let message = 'connect ECONNREFUSED';
  const h = harness({ list: () => { throw new Error(message); } });
  assert.equal(await runAttentionPollOnce(db, h.deps), null);
  assert.equal(await runAttentionPollOnce(db, h.deps), null);
  assert.equal(readCursor(db), 4);
  assert.equal(h.pushes.length, 0);
  assert.equal(h.logs.length, 1);
  message = 'Partner request failed with 401';
  await runAttentionPollOnce(db, h.deps);
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[1], /401/);
  db.close();
});

test('a partner counter below the cursor re-seeds silently instead of muting pushes', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 40);
  const h = harness({ list: () => ({ items: [item('a', 2)], open: 1, seq: 2, alert_seq: 2 }) });
  const tick = await runAttentionPollOnce(db, h.deps);
  assert.equal(tick?.seeded, true);
  assert.equal(readCursor(db), 2);
  assert.equal(h.pushes.length, 0);
  assert.match(h.logs[0], /counter reset/);
  db.close();
});

test('push: false still moves the cursor and the open count but never notifies', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 4);
  const h = harness({ push: false, list: () => ({ items: [item('new', 5)], open: 3, seq: 12, alert_seq: 5 }) });
  const tick = await runAttentionPollOnce(db, h.deps);
  assert.deepEqual(tick, { seeded: false, pushed: 0, open: 3, cursor: 5 });
  assert.equal(readCursor(db), 5);
  assert.equal(h.pushes.length, 0);
  db.close();
});

test('an unconfigured APNs behaves like push: false', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 4);
  const h = harness({ apnsConfigured: false, list: () => ({ items: [item('new', 5)], open: 1, seq: 12, alert_seq: 5 }) });
  const tick = await runAttentionPollOnce(db, h.deps);
  assert.equal(tick?.pushed, 0);
  assert.equal(readCursor(db), 5);
  db.close();
});

test('an unconfigured assistant is dormant: one tick returns null, start logs once and never lists', async () => {
  const db = getDb(':memory:');
  const h = harness({ partner: false });
  assert.equal(await runAttentionPollOnce(db, h.deps), null);
  const poll = startAttentionPoll(db, h.deps);
  assert.equal(poll.openCount(), 0);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /not configured — poll dormant/);
  assert.equal(h.listCalls, 0);
  poll.stop();
  db.close();
});

test('startAttentionPoll ticks immediately and remembers the open count for the badge', async () => {
  const db = getDb(':memory:');
  writeCursor(db, 1);
  const h = harness({ list: () => ({ items: [], open: 7, seq: 3, alert_seq: 1 }) });
  const poll = startAttentionPoll(db, h.deps);
  // The first tick is async; give it a turn of the loop.
  await new Promise((r) => setImmediate(r));
  assert.equal(h.listCalls, 1);
  assert.equal(poll.openCount(), 7);
  assert.match(h.logs[0], /poll started — every 1m, push on/);
  poll.stop();
  db.close();
});
