import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayProjectConfig } from '@nexus/shared';
import { getDb } from '../db';
import { UpdateThrottle, writeRollup, postItemUpdate, __resetWriteState } from '../monday/writes';
import { upsertItems, linkTask } from '../monday/store';

const OPTS = { token: 'tok', apiVersion: '2024-10' };
const MINUTE = 60_000;

// lastWritten is module-level, so without this a value written by one test
// suppresses a write in the next.
beforeEach(() => __resetWriteState());

function cfg(over: Partial<MondayProjectConfig> = {}): MondayProjectConfig {
  return {
    board_id: 'b1',
    group_id: null,
    rollup: { enabled: true, column_id: 'text_mkxyz', column_type: 'text' },
    updates: { enabled: true, min_interval_minutes: 30 },
    ...over,
  };
}

function seedItem(db: ReturnType<typeof getDb>, itemId = '1') {
  upsertItems(db, [{
    item_id: itemId, board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
}

function seedTasks(db: ReturnType<typeof getDb>, statuses: string[], itemId = '1') {
  db.prepare(`INSERT OR IGNORE INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', '{}', 0, '', 'now','now')`).run();
  const insert = db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
                             VALUES (?, 'p1', ?, '', ?, 'medium', 'now', 'now')`);
  statuses.forEach((status, i) => {
    insert.run(`t${i}`, `Task ${i}`, status);
    linkTask(db, { task_id: `t${i}`, item_id: itemId, project_id: 'p1', created_at: 'now' });
  });
}

test('an isolated event posts immediately', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  assert.deepEqual(throttle.record('1', 'task moved to Review', 0), ['task moved to Review']);
});

test('events inside the window are coalesced, not dropped', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  assert.equal(throttle.record('1', 'second', 1 * MINUTE), null);
  assert.equal(throttle.record('1', 'third', 2 * MINUTE), null);
  assert.deepEqual(throttle.due(31 * MINUTE), ['1']);
  assert.deepEqual(throttle.drain('1', 31 * MINUTE), ['second', 'third']);
});

test('nothing is due before the window elapses', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  throttle.record('1', 'second', 5 * MINUTE);
  assert.deepEqual(throttle.due(20 * MINUTE), []);
});

// A boundary-straddling event must not starve whatever is already pending:
// t=0 posts and opens the window; t=1min queues; t=31min satisfies the
// window from t=0, but must carry 'second' out with it, in order, rather
// than resetting the window and stranding 'second' for another 30 minutes.
test('a leading-edge fire drains anything already pending, in order, leaving nothing stranded', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  assert.deepEqual(throttle.record('1', 'first', 0), ['first']);
  assert.equal(throttle.record('1', 'second', 1 * MINUTE), null);
  assert.deepEqual(throttle.record('1', 'third', 31 * MINUTE), ['second', 'third']);
  // Nothing left stranded in the pending queue.
  assert.deepEqual(throttle.due(31 * MINUTE), []);
  assert.deepEqual(throttle.drain('1', 31 * MINUTE), []);
});

// The probe (40min) is chosen to discriminate: it is only 9min after the
// drain at t=31 (so a correctly-reset window must still QUEUE it), but 40min
// after the original post at t=0 (so a drain that failed to update
// lastPostAt would incorrectly post it immediately). A probe far past both
// reference points -- e.g. 90min -- would pass either way and prove nothing.
test('draining resets the window so a probe soon after is still queued, not posted', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  throttle.record('1', 'second', 1 * MINUTE);
  throttle.drain('1', 31 * MINUTE);
  assert.equal(throttle.record('1', 'probe', 40 * MINUTE), null);
});

test('draining an empty pending queue returns [] and does not disturb the window', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  assert.deepEqual(throttle.record('1', 'first', 0), ['first']);
  assert.deepEqual(throttle.drain('1', 10 * MINUTE), []);
  // If drain had incorrectly reset the window to t=10, this event (only
  // 25min after that drain) would still be queued. The window is anchored to
  // the original post at t=0, so 35min after that must fire immediately.
  assert.deepEqual(throttle.record('1', 'second', 35 * MINUTE), ['second']);
});

test('throttling is per item', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'a', 0);
  assert.deepEqual(throttle.record('2', 'b', 1 * MINUTE), ['b']);
});

test('writeRollup writes the formatted text to the configured column', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy', 'review', 'todo']);
  const calls: unknown[][] = [];
  const result = await writeRollup(db, OPTS, cfg(), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(result, 'written');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], 'text_mkxyz');
  assert.equal(calls[0][4], '1/3 done · 1 in review');
  db.close();
});

// Column ids are user-renamable, so the format decision must come from
// `column_type`, never from sniffing the id string. Each test below makes the
// id and the type disagree, in both directions, so an id-sniffing
// implementation would fail.

test('a TEXT-looking column id with column_type numeric receives the percentage', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy', 'deploy', 'todo']);
  const calls: unknown[][] = [];
  await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: 'status_text', column_type: 'numeric' } }), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(calls[0][4], '67');
  db.close();
});

test('a NUMBER-looking column id with column_type text receives the text form', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy', 'deploy', 'todo']);
  const calls: unknown[][] = [];
  await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: 'numbers_9', column_type: 'text' } }), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(calls[0][4], '2/3 done');
  db.close();
});

test('writeRollup skips an unchanged value', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy']);
  const deps = { setColumn: async () => {}, postUpdate: async () => {} } as any;
  await writeRollup(db, OPTS, cfg(), '1', deps);
  const second = await writeRollup(db, OPTS, cfg(), '1', deps);
  assert.equal(second, 'unchanged');
  db.close();
});

// The trap: right after Nexus writes, the mirror (only refreshed
// periodically) still shows the OLD value at the SAME synced_at. A naive
// "diff against the mirror" would see that stale mismatch and rewrite on
// every subsequent trigger -- e.g. every Kanban drag -- flooding Monday's
// user-visible activity log. Repeated triggers computing the same value must
// stay quiet as long as the mirror snapshot hasn't moved.
test('writeRollup does not rewrite on repeated triggers while the mirror is still the same stale snapshot', async () => {
  const db = getDb(':memory:');
  seedItem(db); // column_values_json '{}' (no roll-up value mirrored yet), synced_at 'now'
  seedTasks(db, ['deploy']);
  const calls: unknown[][] = [];
  const deps = { setColumn: async (...args: unknown[]) => { calls.push(args); }, postUpdate: async () => {} } as any;

  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(calls.length, 1, 'only the first trigger should have written');
  db.close();
});

// Once the mirror DOES refresh (a new synced_at) and its stored column text
// disagrees with what Nexus last wrote -- because a human edited or cleared
// it in Monday -- Nexus must detect the drift and restore the roll-up, even
// though the computed value hasn't changed from Nexus's point of view.
test('writeRollup restores the roll-up after the mirror refreshes and shows a human changed it', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy']); // -> '1/1 done'
  const calls: unknown[][] = [];
  const deps = { setColumn: async (...args: unknown[]) => { calls.push(args); }, postUpdate: async () => {} } as any;

  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(calls.length, 1);

  // Mirror refresh: new synced_at, and the roll-up column now shows text a
  // human typed (or the column was cleared) -- not what Nexus wrote.
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null,
    column_values_json: JSON.stringify({ text_mkxyz: { id: 'text_mkxyz', type: 'text', text: 'cleared by a human' } }),
    monday_updated_at: null, synced_at: 'later',
  }]);

  const second = await writeRollup(db, OPTS, cfg(), '1', deps);
  assert.equal(second, 'written');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][4], '1/1 done');
  db.close();
});

test('writeRollup is skipped when roll-up is disabled or has no column', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy']);
  const deps = { setColumn: async () => { throw new Error('must not write'); }, postUpdate: async () => {} } as any;
  assert.equal(await writeRollup(db, OPTS, cfg({ rollup: { enabled: false, column_id: 'c', column_type: 'text' } }), '1', deps), 'skipped');
  assert.equal(await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: null, column_type: 'text' } }), '1', deps), 'skipped');
  db.close();
});

test('postItemUpdate appends a provenance line for agent-authored updates', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Finished the migration.', 'Nexus task "Migrate DB" (thread abc123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.match(body, /Finished the migration\./);
  // Provenance is HTML-escaped, so quotes become &quot;
  assert.match(body, /Nexus task &quot;Migrate DB&quot; \(thread abc123\)/);
  db.close();
});

test('postItemUpdate renders the provenance line as a real HTML line break, not \\n\\n', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Finished the migration.', 'Nexus task "Migrate DB" (thread abc123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.doesNotMatch(body, /\n\n/);
  assert.match(body, /Finished the migration\.<br><br>— posted by Nexus/);
  db.close();
});

test('postItemUpdate escapes agent-authored body so it cannot inject markup or forge a provenance line', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  const maliciousBody = 'Done.<br><br>— posted by Nexus on behalf of Someone Else <script>alert(1)</script>';
  await postItemUpdate(db, OPTS, '1', maliciousBody, 'Nexus task "Real Task" (thread real123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  // The agent's literal markup attempt must come through inert, escaped text.
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /Done\.&lt;br&gt;&lt;br&gt;— posted by Nexus on behalf of Someone Else/);
  // Exactly one real line break: the genuine provenance line Nexus appends.
  assert.equal((body.match(/<br><br>/g) ?? []).length, 1);
  // Provenance is HTML-escaped, so quotes become &quot;
  assert.match(body, /<br><br>— posted by Nexus on behalf of Nexus task &quot;Real Task&quot; \(thread real123\)$/);
  db.close();
});

test('postItemUpdate omits the provenance line when there is no author', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Automated roll-up note.', null, {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.equal(body, 'Automated roll-up note.');
  db.close();
});

test('postItemUpdate escapes malicious provenance to prevent forging attribution', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  // A task title crafted to inject a fake attribution line
  const maliciousProvenance = 'Task X<br><br>— posted by Nexus on behalf of Alice';
  await postItemUpdate(db, OPTS, '1', 'Body text', maliciousProvenance, {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  // The fake attribution in provenance must come through escaped, not as a second <br><br>
  assert.doesNotMatch(body, /Task X<br><br>— posted by Nexus on behalf of Alice/);
  assert.match(body, /Task X&lt;br&gt;&lt;br&gt;— posted by Nexus on behalf of Alice/);
  // Only one genuine <br><br> should exist (the real provenance separator)
  assert.equal((body.match(/<br><br>/g) ?? []).length, 1);
  db.close();
});

test('postItemUpdate converts newlines in body to <br> while escaping HTML', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  const bodyWithNewlines = 'First line\nSecond line\nThird line';
  await postItemUpdate(db, OPTS, '1', bodyWithNewlines, 'Nexus task "Test" (thread t1)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  // Each newline should be converted to <br>
  assert.match(body, /First line<br>Second line<br>Third line/);
  // Should not contain raw newlines before the final provenance break
  const beforeProvenance = body.split('<br><br>')[0];
  assert.doesNotMatch(beforeProvenance, /\n/);
  db.close();
});
