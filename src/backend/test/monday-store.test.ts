import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayItem } from '@nexus/shared';
import { getDb } from '../db';
import {
  upsertItems, pruneScope, getItem, listItemsForBoard,
  linkTask, unlinkTask, getLinkForTask, listLinkedItemIds, listLinkedTaskStatuses,
} from '../monday/store';

function item(id: string, over: Partial<MondayItem> = {}): MondayItem {
  return {
    item_id: id, board_id: 'b1', board_name: 'Portfolio', group_id: 'g1', group_title: 'Q3',
    name: `Item ${id}`, state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null,
    synced_at: '2026-07-22T00:00:00.000Z', ...over,
  };
}

test('upsertItems inserts then updates in place', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1')]);
  upsertItems(db, [item('1', { name: 'Renamed', status_label: 'Done' })]);
  const row = getItem(db, '1')!;
  assert.equal(row.name, 'Renamed');
  assert.equal(row.status_label, 'Done');
  assert.equal(listItemsForBoard(db, 'b1', null).length, 1);
  db.close();
});

test('pruneScope deletes unlinked rows that vanished from the board', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1'), item('2')]);
  const affected = pruneScope(db, 'b1', null, ['1'], '2026-07-22T01:00:00.000Z');
  assert.equal(affected, 1);
  assert.equal(getItem(db, '2'), undefined);
  assert.ok(getItem(db, '1'));
  db.close();
});

test('pruneScope NEVER deletes a linked row — it marks it missing', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1'), item('2')]);
  linkTask(db, { task_id: 't1', item_id: '2', project_id: 'p1', created_at: 'now' });
  pruneScope(db, 'b1', null, ['1'], '2026-07-22T01:00:00.000Z');
  const row = getItem(db, '2');
  assert.ok(row, 'linked row must survive the prune');
  assert.equal(row!.state, 'missing');
  db.close();
});

test('pruneScope is confined to the board and group it synced', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1', { board_id: 'b1' }), item('9', { board_id: 'b2' })]);
  pruneScope(db, 'b1', null, [], '2026-07-22T01:00:00.000Z');
  assert.ok(getItem(db, '9'), 'other boards must be untouched');
  db.close();
});

test('pruneScope with a group set only touches that group', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1', { group_id: 'g1' }), item('2', { group_id: 'g2' })]);
  pruneScope(db, 'b1', 'g1', [], '2026-07-22T01:00:00.000Z');
  assert.equal(getItem(db, '1'), undefined);
  assert.ok(getItem(db, '2'), 'other groups must be untouched');
  db.close();
});

test('linking replaces any prior link for the task', () => {
  const db = getDb(':memory:');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't1', item_id: '2', project_id: 'p1', created_at: 'later' });
  assert.equal(getLinkForTask(db, 't1')!.item_id, '2');
  db.close();
});

test('unlinkTask removes the link', () => {
  const db = getDb(':memory:');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  unlinkTask(db, 't1');
  assert.equal(getLinkForTask(db, 't1'), undefined);
  db.close();
});

test('listLinkedItemIds is distinct across projects', () => {
  const db = getDb(':memory:');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't2', item_id: '1', project_id: 'p2', created_at: 'now' });
  linkTask(db, { task_id: 't3', item_id: '2', project_id: 'p1', created_at: 'now' });
  assert.deepEqual(listLinkedItemIds(db).sort(), ['1', '2']);
  db.close();
});

test('listLinkedTaskStatuses joins through to the tasks table', () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','', '', '{}', 0, '', 'now', 'now')`).run();
  const insertTask = db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
                                 VALUES (?, 'p1', ?, '', ?, 'medium', 'now', 'now')`);
  insertTask.run('t1', 'A', 'deploy');
  insertTask.run('t2', 'B', 'review');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't2', item_id: '1', project_id: 'p1', created_at: 'now' });
  assert.deepEqual(listLinkedTaskStatuses(db, '1').sort(), ['deploy', 'review']);
  db.close();
});
