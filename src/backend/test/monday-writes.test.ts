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

test('draining resets the window so the next isolated event posts immediately', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  throttle.record('1', 'second', 1 * MINUTE);
  throttle.drain('1', 31 * MINUTE);
  assert.deepEqual(throttle.record('1', 'later', 90 * MINUTE), ['later']);
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

test('a numeric column receives the percentage, not the text form', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy', 'deploy', 'todo']);
  const calls: unknown[][] = [];
  await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: 'numbers_9', column_type: 'numeric' } }), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(calls[0][4], '67');
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
  assert.match(body, /Nexus task "Migrate DB" \(thread abc123\)/);
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
