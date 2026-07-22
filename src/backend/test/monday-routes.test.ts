delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '../db';
import { registerMondayRoutes } from '../routes/monday';
import { upsertItems, getLinkForTask } from '../monday/store';
import { loadConfig, saveConfig } from '../config';

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

/**
 * clientOptions() in routes/monday.ts reads loadConfig().monday.enabled and
 * resolveMondayToken() (MONDAY_TOKEN) directly — there is no fetchImpl seam
 * exposed at the route layer the way syncScope/mondayGraphql expose one to
 * their own unit tests. To drive a real Monday call through the route we
 * therefore have to (a) flip monday.enabled on the real on-disk config the
 * same way test/routes-settings.test.ts and test/routes-projects.test.ts
 * already do, restoring it in `finally`, and (b) set MONDAY_TOKEN so
 * resolveMondayToken() returns truthy, deleting it after. Both are undone
 * unconditionally so they can't leak into later tests.
 */
async function withMondayEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const original = loadConfig();
  process.env.MONDAY_TOKEN = 'test-token';
  saveConfig({ ...original, monday: { ...original.monday, enabled: true } });
  try {
    return await fn();
  } finally {
    delete process.env.MONDAY_TOKEN;
    saveConfig(original);
  }
}

/**
 * mondayGraphql's transport is `opts.fetchImpl ?? fetch` (client.ts); the
 * route never sets fetchImpl, so it always falls through to the global
 * `fetch`. Stubbing globalThis.fetch is therefore the least invasive seam
 * available to make a Monday call fail from outside the module — no
 * production code changes needed. Always restored in `finally`.
 */
function stubMondayAuthFailure(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    errors: [{ message: 'Not Authenticated', extensions: { code: 'UserUnauthorizedException' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  return () => { globalThis.fetch = original; };
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

  const first = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
  assert.equal(first.statusCode, 200);
  assert.equal(getLinkForTask(db, 't1')!.item_id, '1');

  // Re-POST the SAME task_id with a DIFFERENT item_id. task_id is the
  // primary key and linkTask upserts on it, so this must replace the row,
  // not append a second one.
  const second = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '2', project_id: 'p1' } });
  assert.equal(second.statusCode, 200);
  assert.equal(getLinkForTask(db, 't1')!.item_id, '2');

  // Prove there is no duplicate row left behind by the first link.
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM task_monday_links WHERE task_id = ?').get('t1') as { c: number };
  assert.equal(c, 1);

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

test('POST links 404s when task_id does not exist', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 'nope', item_id: '1', project_id: 'p1' } });
  assert.equal(res.statusCode, 404);
  assert.equal(getLinkForTask(db, 'nope'), undefined);
  await app.close();
  db.close();
});

test('POST links 404s when project_id does not exist', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'nope' } });
  assert.equal(res.statusCode, 404);
  assert.equal(getLinkForTask(db, 't1'), undefined);
  await app.close();
  db.close();
});

test('POST links 400s when the task belongs to a different project than supplied', async () => {
  const db = getDb(':memory:');
  seed(db);
  // A second, real project that t1 does NOT belong to.
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p2','p2','P2','P2','','', '{}', 0, '', 'now','now')`).run();
  const app = await buildApp(db);
  // t1 belongs to p1 (seeded above), but the caller claims it links into p2.
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p2' } });
  assert.equal(res.statusCode, 400);
  assert.equal(getLinkForTask(db, 't1'), undefined);
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

test('GET links returns a project\'s links', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/links' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().links.length, 1);
  await app.close();
  db.close();
});

test('GET links 404s for an unknown project, consistent with /items and /search', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/nope/links' });
  assert.equal(res.statusCode, 404);
  // Must not silently degrade to an empty-links success shape.
  assert.equal('links' in res.json(), false);
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

// --- 502-on-Monday-failure: the single behaviour this feature exists to
// protect. A user must never see "no items" because their token expired —
// these prove both live-Monday-call endpoints surface the failure instead of
// silently degrading to a success shape.

test('GET items?refresh=1 502s (not an empty-success shape) when the Monday sync call fails', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const unstub = stubMondayAuthFailure();
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/items?refresh=1' });
      assert.equal(res.statusCode, 502);
      const body = res.json() as { error?: string; code?: string; items?: unknown };
      assert.match(body.error ?? '', /Not Authenticated/);
      assert.equal(body.code, 'UserUnauthorizedException');
      // Never a success shape with an empty items array.
      assert.equal('items' in body, false);
    });
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

test('GET search 502s (not an empty-success shape) when the live Monday fetch fails', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const unstub = stubMondayAuthFailure();
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/search?q=foo' });
      assert.equal(res.statusCode, 502);
      const body = res.json() as { error?: string; code?: string; items?: unknown };
      assert.match(body.error ?? '', /Not Authenticated/);
      assert.equal(body.code, 'UserUnauthorizedException');
      // Never a success shape with an empty items array.
      assert.equal('items' in body, false);
    });
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});
