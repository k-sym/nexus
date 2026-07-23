delete process.env.MONDAY_TOKEN;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerMondayRoutes } from '../routes/monday';
import { upsertItems, getLinkForTask, getItem } from '../monday/store';
import { loadConfig, saveConfig } from '../config';
import type { ActivityEvent } from '../activity/events';

// withMondayEnabled below calls saveConfig(), which writes config.yaml for
// real. Relocate the whole ~/.nexus tree to a scratch dir first: config.ts
// reads NEXUS_HOME on each call, so setting it here (after imports) still
// takes effect before any loadConfig/saveConfig call in this file.
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-monday-routes-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

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
 * A minimal stand-in for the real ActivityManager, matching the same shape
 * test/routes-missions.test.ts already decorates with — `{ bus: { emit } }`
 * is all routes/monday.ts reads (`fastify.activity?.bus.emit`).
 */
async function buildAppWithActivity(db: ReturnType<typeof getDb>): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; events: ActivityEvent[] }> {
  const events: ActivityEvent[] = [];
  const app = Fastify();
  app.decorate('db', db);
  (app as any).decorate('activity', { bus: { emit: (e: ActivityEvent) => events.push(e) } });
  await app.register(registerMondayRoutes);
  return { app: app as any, events };
}

/**
 * scheduleRollup/scheduleRollupForItem are fired without awaiting (void) —
 * the route responds before the background write settles. Poll briefly for
 * the expected event count rather than a fixed sleep.
 */
async function waitForEvents(events: ActivityEvent[], minCount: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (events.length < minCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${minCount} activity events; got ${events.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * clientOptions() in routes/monday.ts reads loadConfig().monday.enabled and
 * resolveMondayToken() (MONDAY_TOKEN) directly — there is no fetchImpl seam
 * exposed at the route layer the way syncScope/mondayGraphql expose one to
 * their own unit tests. To drive a real Monday call through the route we
 * therefore have to (a) flip monday.enabled on the on-disk config the same
 * way test/routes-settings.test.ts and test/routes-projects.test.ts already
 * do, restoring it in `finally`, and (b) set MONDAY_TOKEN so
 * resolveMondayToken() returns truthy, deleting it after. Both are undone
 * unconditionally so they can't leak into later tests. loadConfig/saveConfig
 * here target the private per-file scratch NEXUS_HOME set up above, never
 * the developer's real ~/.nexus/config.yaml.
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

/**
 * Answers the `items(ids: [...])` query (fetchItemsByIds, used by POST
 * /links to mirror an item the picker found live but that has never been
 * through a scope sync) with one item, and answers anything else — notably
 * the roll-up write mutation POST /links also fires fire-and-forget
 * afterwards — with an empty success so it doesn't throw and pollute the
 * test with an unrelated unhandled rejection.
 */
function stubMondayItemFetch(itemId: string, name: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse((init?.body as string) ?? '{}');
    if (typeof parsed.query === 'string' && parsed.query.includes('ItemsByIds')) {
      return new Response(JSON.stringify({
        data: {
          items: [{
            id: itemId, name, state: 'active', updated_at: null, url: null,
            board: { id: 'b1', name: 'Portfolio' }, group: null, column_values: [],
          }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
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

test('POST links mirrors an item the picker found live but that has no mirror row yet', async () => {
  // The picker searches Monday LIVE, so it can hand back an item id that has
  // never been through a scope sync — no row in monday_items. Before this
  // fix, writeRollup's getItem(db, itemId) found nothing and silently
  // returned 'skipped': no roll-up write, no badge, no agent context, until
  // some unrelated task on the same item happened to move.
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  assert.equal(getItem(db, '5'), undefined, 'item 5 must start unmirrored — the exact gap this test covers');
  const unstub = stubMondayItemFetch('5', 'Fresh from Monday');
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '5', project_id: 'p1' } });
      assert.equal(res.statusCode, 200);
    });
    assert.equal(getLinkForTask(db, 't1')!.item_id, '5');
    assert.equal(
      getItem(db, '5')?.name, 'Fresh from Monday',
      'the item must be mirrored by the time the link exists, so the roll-up write and badge do not silently no-op',
    );
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

test('POST links surfaces a Monday mirror-fetch failure and creates no link (no half-created state)', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const unstub = stubMondayAuthFailure();
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '5', project_id: 'p1' } });
      assert.equal(res.statusCode, 502);
      const body = res.json() as { error?: string; code?: string; retryable?: boolean };
      assert.match(body.error ?? '', /Not Authenticated/);
      assert.equal(body.code, 'UserUnauthorizedException');
    });
    // Keep the handler's existing failure behaviour: a Monday error must
    // surface (asserted above) and must not leave a half-created state —
    // no link row for a fetch that never completed.
    assert.equal(getLinkForTask(db, 't1'), undefined, 'a failed mirror fetch must not leave a half-created link');
    assert.equal(getItem(db, '5'), undefined);
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

test('POST links skips the mirror fetch (and still links) when an item is already mirrored', async () => {
  // seed() already upserts item '1'. This proves the fetch-before-link step
  // is conditional on absence, not an unconditional extra live call on every
  // link — the auth-failure stub below would 502 the request if the route
  // fetched regardless of mirror state.
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const unstub = stubMondayAuthFailure();
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
      assert.equal(res.statusCode, 200);
    });
    assert.equal(getLinkForTask(db, 't1')!.item_id, '1');
  } finally {
    unstub();
    await app.close();
    db.close();
  }
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

test('POST links emits a monday_write activity operation, not just Kanban moves', async () => {
  // Before this fix, link/unlink/task-delete called scheduleRollup /
  // scheduleRollupForItem WITHOUT an emit argument — only the Kanban
  // status-change path in routes/projects.ts produced a monday_write
  // operation, so these writes were invisible in the Activity Console.
  const db = getDb(':memory:');
  seed(db);
  const { app, events } = await buildAppWithActivity(db);
  const unstub = stubMondayItemFetch('1', 'Initiative');
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
      assert.equal(res.statusCode, 200);
      await waitForEvents(events, 2);
    });
    assert.ok(events.some((e) => e.kind === 'monday_write'), 'a link must produce a monday_write operation');
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

test('DELETE links emits a monday_write activity operation', async () => {
  const db = getDb(':memory:');
  seed(db);
  const { app, events } = await buildAppWithActivity(db);
  const unstub = stubMondayItemFetch('1', 'Initiative');
  try {
    await withMondayEnabled(async () => {
      const link = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
      assert.equal(link.statusCode, 200);
      await waitForEvents(events, 2);
      events.length = 0; // isolate the unlink's own events from the link's

      const res = await app.inject({ method: 'DELETE', url: '/api/monday/links/t1' });
      assert.equal(res.statusCode, 200);
      await waitForEvents(events, 2);
    });
    assert.ok(events.some((e) => e.kind === 'monday_write'), 'an unlink must produce a monday_write operation');
  } finally {
    unstub();
    await app.close();
    db.close();
  }
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
