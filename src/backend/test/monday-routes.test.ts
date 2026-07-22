delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '../db';
import { registerMondayRoutes } from '../routes/monday';
import { upsertItems, getLinkForTask } from '../monday/store';

function seed(db: ReturnType<typeof getDb>) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: false, min_interval_minutes: 30 },
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','A','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
}

// The neighbouring route modules (routes/tickets.ts, routes/braindump.ts) take
// only a FastifyInstance and read `fastify.db`, decorated once at app-boot in
// index.ts. registerMondayRoutes follows the same convention rather than
// taking a { db } deps argument, so tests decorate 'db' the same way
// routes-status.test.ts / braindump-routes.test.ts do.
async function buildApp(db: ReturnType<typeof getDb>) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(registerMondayRoutes);
  return app;
}

test('GET items returns mirrored items with roll-up and linked task ids', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });

  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/items' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: { item_id: string; rollup_text: string; task_ids: string[] }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].rollup_text, '1/1 done');
  assert.deepEqual(body.items[0].task_ids, ['t1']);
  await app.close();
  db.close();
});

test('POST links creates a link and replaces an existing one', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(getLinkForTask(db, 't1')!.item_id, '1');
  await app.close();
  db.close();
});

test('POST links rejects a missing field', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1' } });
  assert.equal(res.statusCode, 400);
  await app.close();
  db.close();
});

test('DELETE links removes the link', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
  const res = await app.inject({ method: 'DELETE', url: '/api/monday/links/t1' });
  assert.equal(res.statusCode, 200);
  assert.equal(getLinkForTask(db, 't1'), undefined);
  await app.close();
  db.close();
});

test('GET status reports unconfigured without a token', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/status' });
  assert.equal(res.json().configured, false);
  await app.close();
  db.close();
});

test('GET items 404s for an unknown project', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/nope/items' });
  assert.equal(res.statusCode, 404);
  await app.close();
  db.close();
});

test('GET items 409s when the project has no Monday scope configured', async () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p2','p2','P2','P2','','', '{}', 0, '', 'now','now')`).run();
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p2/items' });
  assert.equal(res.statusCode, 409);
  await app.close();
  db.close();
});
