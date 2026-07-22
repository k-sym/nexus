import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import { syncScope, refreshLinkedItems } from '../monday/sync';
import { getItem, linkTask, upsertItems } from '../monday/store';
import { MondayError } from '../monday/client';
import type { MondayItem } from '@nexus/shared';

const OPTS = { token: 'tok', apiVersion: '2024-10' };
const NOW = '2026-07-22T10:00:00.000Z';

function raw(id: string, name = `Item ${id}`) {
  return {
    id, name, state: 'active', updated_at: null, url: null,
    board: { id: 'b1', name: 'Portfolio' }, group: { id: 'g1', title: 'Q3' },
    column_values: [],
  };
}

test('syncScope mirrors fetched items', async () => {
  const db = getDb(':memory:');
  const result = await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1'), raw('2')] as any);
  assert.deepEqual(result, { fetched: 2, pruned: 0 });
  assert.equal(getItem(db, '1')!.name, 'Item 1');
  db.close();
});

test('syncScope prunes rows the board no longer returns', async () => {
  const db = getDb(':memory:');
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1'), raw('2')] as any);
  const result = await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1')] as any);
  assert.equal(result.pruned, 1);
  assert.equal(getItem(db, '2'), undefined);
  db.close();
});

test('syncScope never drops a linked item', async () => {
  const db = getDb(':memory:');
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1'), raw('2')] as any);
  linkTask(db, { task_id: 't1', item_id: '2', project_id: 'p1', created_at: NOW });
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1')] as any);
  assert.equal(getItem(db, '2')!.state, 'missing');
  db.close();
});

test('syncScope propagates client errors rather than silently mirroring nothing', async () => {
  const db = getDb(':memory:');
  await assert.rejects(
    () => syncScope(db, OPTS, 'b1', null, NOW, async () => {
      throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
    }),
    /Not Authenticated/,
  );
  db.close();
});

test('an auth failure must not be mistaken for an empty board', async () => {
  const db = getDb(':memory:');
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1')] as any);
  await assert.rejects(() => syncScope(db, OPTS, 'b1', null, NOW, async () => {
    throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
  }));
  assert.ok(getItem(db, '1'), 'a failed sync must not prune the existing mirror');
  db.close();
});

test('refreshLinkedItems queries only linked ids', async () => {
  const db = getDb(':memory:');
  const stale: MondayItem = {
    item_id: '5', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Old', state: 'active', status_label: null, status_color: null, owners_json: '[]',
    url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'old',
  };
  upsertItems(db, [stale]);
  linkTask(db, { task_id: 't1', item_id: '5', project_id: 'p1', created_at: NOW });

  let askedFor: string[] = [];
  const count = await refreshLinkedItems(db, OPTS, NOW, async (_o, ids) => {
    askedFor = ids;
    return [{ ...raw('5', 'Fresh'), board: { id: 'b1', name: 'Portfolio' } }] as any;
  });
  assert.deepEqual(askedFor, ['5']);
  assert.equal(count, 1);
  assert.equal(getItem(db, '5')!.name, 'Fresh');
  db.close();
});

test('refreshLinkedItems marks a linked item Monday no longer returns as missing', async () => {
  const db = getDb(':memory:');
  upsertItems(db, [{
    item_id: '7', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Gone', state: 'active', status_label: null, status_color: null, owners_json: '[]',
    url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'old',
  }]);
  linkTask(db, { task_id: 't1', item_id: '7', project_id: 'p1', created_at: NOW });
  await refreshLinkedItems(db, OPTS, NOW, async () => []);
  assert.equal(getItem(db, '7')!.state, 'missing');
  db.close();
});

test('refreshLinkedItems is a no-op when nothing is linked', async () => {
  const db = getDb(':memory:');
  let called = false;
  const count = await refreshLinkedItems(db, OPTS, NOW, async () => { called = true; return []; });
  assert.equal(count, 0);
  assert.equal(called, false);
  db.close();
});
