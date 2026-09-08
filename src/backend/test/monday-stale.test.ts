delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '../db';
import { registerMondayRoutes } from '../routes/monday';
import { upsertItems, linkTask } from '../monday/store';
import { buildStaleReport, listScopedProjects } from '../monday/stale';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function seedProject(db: ReturnType<typeof getDb>, id: string, name: string, boardId: string, groupId: string | null, sort = 0) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES (?, ?, ?, ?, '', '', ?, ?, '', 'now', 'now')`)
    .run(id, id, name, name, JSON.stringify({
      monday: {
        board_id: boardId, group_id: groupId,
        rollup: { enabled: false, column_id: null, column_type: 'text' },
        updates: { enabled: false, min_interval_minutes: 30 },
      },
    }), sort);
}

function item(over: Partial<Parameters<typeof upsertItems>[1][number]>) {
  return {
    item_id: 'x', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Item', state: 'active' as const, status_label: 'Working on it', status_color: null,
    owners_json: '["Ann"]', url: 'https://m/1', column_values_json: '{}', updates_json: '[]',
    monday_updated_at: null, synced_at: daysAgo(0),
    ...over,
  };
}

function seed(db: ReturnType<typeof getDb>) {
  seedProject(db, 'p1', 'MyWise', 'b1', null, 0);
  seedProject(db, 'p2', 'Other', 'b2', 'g9', 1);
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p3','p3','Unscoped','U','','','{}',2,'','now','now')`).run();
  upsertItems(db, [
    item({ item_id: 'fresh', name: 'Moved yesterday', monday_updated_at: daysAgo(1) }),
    item({ item_id: 'stale', name: 'Quiet for ten days', monday_updated_at: daysAgo(10) }),
    item({ item_id: 'commented', name: 'Old column, recent comment', monday_updated_at: daysAgo(20), updates_json: JSON.stringify([{ text: 'ping', created_at: daysAgo(2) }]) }),
    item({ item_id: 'kanban', name: 'Old on Monday, task moved in Nexus', monday_updated_at: daysAgo(30) }),
    item({ item_id: 'undated', name: 'Never dated' }),
    item({ item_id: 'done', name: 'Finished ages ago', monday_updated_at: daysAgo(40), status_label: 'Done' }),
    item({ item_id: 'gone', name: 'Archived', monday_updated_at: daysAgo(40), state: 'archived' }),
    item({ item_id: 'other-board', board_id: 'b2', group_id: 'g9', board_name: 'Second', name: 'On the other board', monday_updated_at: daysAgo(9), synced_at: daysAgo(3) }),
    item({ item_id: 'other-group', board_id: 'b2', group_id: 'g1', board_name: 'Second', name: 'Outside the scoped group', monday_updated_at: daysAgo(9) }),
  ]);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','Fix it','','in_progress','medium','now', ?)`).run(daysAgo(1));
  linkTask(db, { task_id: 't1', item_id: 'kanban', project_id: 'p1', created_at: 'now' });
}

test('listScopedProjects returns only projects with a Monday scope, in sort order', () => {
  const db = getDb(':memory:');
  seed(db);
  assert.deepEqual(listScopedProjects(db).map((s) => s.project.id), ['p1', 'p2']);
  db.close();
});

test('buildStaleReport uses the latest of Monday updated_at, newest update, and linked-task movement', () => {
  const db = getDb(':memory:');
  seed(db);
  const report = buildStaleReport(db, 7, NOW);
  assert.equal(report.days, 7);
  const p1 = report.projects.find((p) => p.project_id === 'p1')!;
  assert.deepEqual(p1.items.map((i) => i.item_id), ['undated', 'done', 'stale'], 'longest idle first, undated at the top');
  const stale = p1.items.find((i) => i.item_id === 'stale')!;
  assert.equal(stale.days_idle, 10);
  assert.equal(stale.last_movement, daysAgo(10));
  assert.deepEqual(stale.owners, ['Ann']);
  const undated = p1.items.find((i) => i.item_id === 'undated')!;
  assert.equal(undated.days_idle, null);
  assert.equal(undated.last_movement, null);
  db.close();
});

test('buildStaleReport skips archived/deleted/missing items and honours exclude labels', () => {
  const db = getDb(':memory:');
  seed(db);
  const report = buildStaleReport(db, 7, NOW, ['done']);
  const p1 = report.projects.find((p) => p.project_id === 'p1')!;
  assert.deepEqual(p1.items.map((i) => i.item_id), ['undated', 'stale']);
  db.close();
});

test('buildStaleReport respects each project\'s board and group scope and reports mirror freshness', () => {
  const db = getDb(':memory:');
  seed(db);
  const p2 = buildStaleReport(db, 7, NOW).projects.find((p) => p.project_id === 'p2')!;
  assert.deepEqual(p2.items.map((i) => i.item_id), ['other-board']);
  assert.equal(p2.board_name, 'Second');
  assert.equal(p2.synced_at, daysAgo(3));
  db.close();
});

test('a linked task that moved recently counts as movement, with the task listed', () => {
  const db = getDb(':memory:');
  seed(db);
  const p1 = buildStaleReport(db, 7, NOW).projects.find((p) => p.project_id === 'p1')!;
  assert.equal(p1.items.some((i) => i.item_id === 'kanban'), false);
  const wide = buildStaleReport(db, 0, NOW).projects.find((p) => p.project_id === 'p1')!;
  const kanban = wide.items.find((i) => i.item_id === 'kanban')!;
  assert.equal(kanban.linked_tasks.length, 1);
  assert.equal(kanban.linked_tasks[0].title, 'Fix it');
  assert.equal(kanban.days_idle, 1);
  db.close();
});

async function buildApp(db: ReturnType<typeof getDb>) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(registerMondayRoutes);
  return app;
}

test('GET /api/monday/stale defaults to 7 days and never fails when a refresh cannot run', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/stale?refresh=1&exclude_labels=Done' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.days, 7);
  assert.deepEqual(body.refreshed, []);
  assert.match(body.warnings[0], /refresh skipped/);
  assert.deepEqual(body.projects.map((p: any) => p.items.map((i: any) => i.item_id)), [['undated', 'stale'], ['other-board']]);
  await app.close();
  db.close();
});

test('GET /api/monday/stale rejects a malformed days value', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/stale?days=soon' });
  assert.equal(res.statusCode, 400);
  await app.close();
  db.close();
});
