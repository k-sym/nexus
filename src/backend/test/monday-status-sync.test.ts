import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayProjectConfig } from '@nexus/shared';
import { getDb } from '../db';
import { deriveItemStage, writeStatus, __resetStatusSyncState } from '../monday/status-sync';
import { computeRollup } from '../monday/rollup';
import { upsertItems, linkTask } from '../monday/store';

const OPTS = { token: 'tok', apiVersion: '2026-07' };
const COLUMN = 'color_1';

// lastWrittenStatus is module-level, so without this a value written by one
// test suppresses a write in the next (mirrors monday-writes.test.ts).
beforeEach(() => __resetStatusSyncState());

type StatusSync = NonNullable<MondayProjectConfig['status_sync']>;

function cfg(over: Partial<StatusSync> = {}): MondayProjectConfig {
  return {
    board_id: 'b1',
    group_id: null,
    rollup: { enabled: false, column_id: null, column_type: 'text' },
    updates: { enabled: false, min_interval_minutes: 30 },
    status_sync: {
      enabled: true,
      column_id: COLUMN,
      forward_only: true,
      mapping: {
        triage: 'Planned', todo: 'Planned', in_progress: 'In flight',
        review: 'Near done', deploy: 'Complete',
      },
      ...over,
    },
  };
}

function seedItem(
  db: ReturnType<typeof getDb>,
  { itemId = '1', statusText = null as string | null, syncedAt = 'now' } = {},
) {
  const column_values_json = statusText === null
    ? '{}'
    : JSON.stringify({ [COLUMN]: { id: COLUMN, type: 'status', text: statusText } });
  upsertItems(db, [{
    item_id: itemId, board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: statusText, status_color: null,
    owners_json: '[]', url: null, column_values_json, monday_updated_at: null, synced_at: syncedAt,
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

function captureDeps() {
  const calls: unknown[][] = [];
  return { calls, deps: { setStatus: async (...args: unknown[]) => { calls.push(args); } } as never };
}

// --- deriveItemStage (the aggregate rule) --------------------------------

test('deriveItemStage: no linked tasks → null', () => {
  assert.equal(deriveItemStage(computeRollup([])), null);
});

test('deriveItemStage: all open → todo', () => {
  assert.equal(deriveItemStage(computeRollup(['triage', 'todo'])), 'todo');
});

test('deriveItemStage: any in-progress → in_progress', () => {
  assert.equal(deriveItemStage(computeRollup(['todo', 'in_progress'])), 'in_progress');
});

test('deriveItemStage: any review outranks in-progress → review', () => {
  assert.equal(deriveItemStage(computeRollup(['in_progress', 'review'])), 'review');
});

test('deriveItemStage: deploy only when every task is done', () => {
  assert.equal(deriveItemStage(computeRollup(['deploy', 'deploy'])), 'deploy');
  assert.notEqual(deriveItemStage(computeRollup(['deploy', 'todo'])), 'deploy');
});

// --- writeStatus: the happy path and the aggregate ------------------------

test('writeStatus writes the mapped label for the aggregate stage', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), ['b1', '1', COLUMN, 'In flight']);
  db.close();
});

test('an item is Complete only when every linked task is done', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['deploy', 'in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(calls[0][4], 'In flight'); // not 'Complete'
  db.close();
});

test('all linked tasks done → Complete', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['deploy', 'deploy']);
  const { calls, deps } = captureDeps();
  await writeStatus(db, OPTS, cfg(), '1', deps);
  assert.equal(calls[0][4], 'Complete');
  db.close();
});

test('review outranks in-progress in the aggregate', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['review', 'in_progress']);
  const { calls, deps } = captureDeps();
  await writeStatus(db, OPTS, cfg(), '1', deps);
  assert.equal(calls[0][4], 'Near done');
  db.close();
});

test('writeStatus writes only labels present in the mapping — never the inbox label', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['triage']);
  const { calls, deps } = captureDeps();
  await writeStatus(db, OPTS, cfg(), '1', deps);
  assert.ok(['Planned', 'In flight', 'Near done', 'Complete'].includes(calls[0][4] as string));
  assert.notEqual(calls[0][4], 'Wants attention');
  db.close();
});

// --- writeStatus: the skips -----------------------------------------------

test('writeStatus is skipped when status sync is disabled', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg({ enabled: false }), '1', deps), 'skipped');
  assert.equal(calls.length, 0);
  db.close();
});

test('writeStatus is skipped when there is no column', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['in_progress']);
  const { deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg({ column_id: null }), '1', deps), 'skipped');
  db.close();
});

test('writeStatus is skipped (not thrown) with no status_sync sub-key at all', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['in_progress']);
  const { deps } = captureDeps();
  const partial = {
    board_id: 'b1', group_id: null,
    rollup: { enabled: false, column_id: null, column_type: 'text' },
    updates: { enabled: false, min_interval_minutes: 30 },
  } as MondayProjectConfig;
  assert.equal(await writeStatus(db, OPTS, partial, '1', deps), 'skipped');
  db.close();
});

test('writeStatus is skipped when the item has no linked tasks', async () => {
  const db = getDb(':memory:'); seedItem(db);
  const { deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'skipped');
  db.close();
});

test('writeStatus is skipped when the aggregate stage has no mapped label', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  // mapping omits in_progress
  assert.equal(await writeStatus(db, OPTS, cfg({ mapping: { deploy: 'Complete' } }), '1', deps), 'skipped');
  assert.equal(calls.length, 0);
  db.close();
});

// --- writeStatus: no-op + self-healing baseline ---------------------------

test('writeStatus is a no-op when the column already shows the target', async () => {
  const db = getDb(':memory:'); seedItem(db, { statusText: 'In flight' }); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(calls.length, 0);
  db.close();
});

test('repeated triggers stay quiet while the mirror snapshot is unchanged', async () => {
  const db = getDb(':memory:'); seedItem(db); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(calls.length, 1, 'only the first trigger should have written');
  db.close();
});

// --- writeStatus: the hold rule -------------------------------------------

test('a human-held label outside the mapping is never overwritten by a plain move', async () => {
  const db = getDb(':memory:'); seedItem(db, { statusText: 'Wants attention' }); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'skipped');
  assert.equal(calls.length, 0);
  db.close();
});

test('the link handoff may advance off a human-held label', async () => {
  const db = getDb(':memory:'); seedItem(db, { statusText: 'Wants attention' }); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(
    await writeStatus(db, OPTS, cfg(), '1', deps, { allowAdvanceFromUnmanaged: true }),
    'written',
  );
  assert.equal(calls[0][4], 'In flight');
  db.close();
});

test('a blank status is advanceable on a plain move (not a hold)', async () => {
  const db = getDb(':memory:'); seedItem(db, { statusText: null }); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(calls[0][4], 'In flight');
  db.close();
});

// --- writeStatus: forward-only --------------------------------------------

test('forward-only blocks a regression to an earlier stage', async () => {
  const db = getDb(':memory:'); seedItem(db, { statusText: 'Complete' }); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg(), '1', deps), 'skipped');
  assert.equal(calls.length, 0);
  db.close();
});

test('forward-only off allows a regression', async () => {
  const db = getDb(':memory:'); seedItem(db, { statusText: 'Complete' }); seedTasks(db, ['in_progress']);
  const { calls, deps } = captureDeps();
  assert.equal(await writeStatus(db, OPTS, cfg({ forward_only: false }), '1', deps), 'written');
  assert.equal(calls[0][4], 'In flight');
  db.close();
});
