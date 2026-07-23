delete process.env.MONDAY_TOKEN;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerMondayRoutes } from '../routes/monday';
import { loadConfig, saveConfig } from '../config';

// withMondayEnabled below calls saveConfig(), which writes config.yaml for
// real. Relocate the whole ~/.nexus tree to a scratch dir first: config.ts
// reads NEXUS_HOME on each call, so setting it here (after imports) still
// takes effect before any loadConfig/saveConfig call in this file.
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-monday-config-routes-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

/**
 * Task 15: per-project Monday scope configuration — GET/PUT
 * /api/monday/projects/:projectId/config and the live GET /api/monday/boards
 * + GET /api/monday/boards/:boardId/meta pickers that feed it.
 *
 * Follows monday-routes.test.ts's conventions: registerMondayRoutes reads
 * fastify.db (decorated per-test, not a { db } deps argument), and
 * withMondayEnabled/stubMondayAuthFailure/jsonResponse-style fetch stubs are
 * the seam for driving the live-Monday-call endpoints without a network call.
 */

function seedProjectWithMonday(db: ReturnType<typeof getDb>, id = 'p1') {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES (?, ?, 'P', 'P', '', '', ?, 0, '', 'now', 'now')`)
    .run(id, id, JSON.stringify({
      column_defaults: { triage: 'x1', todo: null, in_progress: null, review: null, deploy: null },
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: false, min_interval_minutes: 30 },
      },
    }));
}

function seedProjectWithoutMonday(db: ReturnType<typeof getDb>, id = 'p1') {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES (?, ?, 'P', 'P', '', '', ?, 0, '', 'now', 'now')`)
    .run(id, id, JSON.stringify({ column_defaults: { triage: null, todo: null, in_progress: null, review: null, deploy: null } }));
}

async function buildApp(db: ReturnType<typeof getDb>) {
  const app = Fastify();
  app.decorate('db', db);
  await app.register(registerMondayRoutes);
  return app;
}

/** Same helper as monday-routes.test.ts: flips Monday on for the duration of
 *  `fn`, against the private per-file scratch NEXUS_HOME set up above, never
 *  the developer's real ~/.nexus/config.yaml. Always restored in `finally`. */
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubMondayFetch(handler: (query: string, variables: any) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse((init?.body as string) ?? '{}');
    return jsonResponse(handler(parsed.query, parsed.variables));
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function stubMondayAuthFailure(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({
    errors: [{ message: 'Not Authenticated', extensions: { code: 'UserUnauthorizedException' } }],
  })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const VALID_CONFIG = {
  board_id: 'b1',
  group_id: 'g1',
  rollup: { enabled: true, column_id: 'text_1', column_type: 'text' as const },
  updates: { enabled: true, min_interval_minutes: 30 },
};

// --- GET /api/monday/boards ---------------------------------------------

test('GET boards 409s when Monday is disabled or tokenless', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/boards' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'monday_disabled');
  await app.close();
  db.close();
});

test('GET boards returns the live board list with workspace names', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const unstub = stubMondayFetch(() => ({
    data: { boards: [{ id: '1', name: 'Portfolio', workspace: { name: 'Product' } }] },
  }));
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/monday/boards' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().boards, [{ id: '1', name: 'Portfolio', workspace: 'Product' }]);
    });
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

test('GET boards 502s (not an empty-success shape) when Monday fails', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const unstub = stubMondayAuthFailure();
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/monday/boards' });
      assert.equal(res.statusCode, 502);
      const body = res.json() as { error?: string; code?: string; boards?: unknown };
      assert.match(body.error ?? '', /Not Authenticated/);
      assert.equal(body.code, 'UserUnauthorizedException');
      assert.equal('boards' in body, false);
    });
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

// --- GET /api/monday/boards/:boardId/meta -------------------------------

test('GET board meta 409s when Monday is disabled or tokenless', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/boards/b1/meta' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'monday_disabled');
  await app.close();
  db.close();
});

test('GET board meta returns groups and columns', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const unstub = stubMondayFetch(() => ({
    data: {
      boards: [{
        groups: [{ id: 'g1', title: 'Q3' }],
        columns: [{ id: 'text_1', title: 'Points', type: 'numbers' }],
      }],
    },
  }));
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/monday/boards/b1/meta' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.groups, [{ id: 'g1', title: 'Q3' }]);
      assert.deepEqual(body.columns, [{ id: 'text_1', title: 'Points', type: 'numbers' }]);
    });
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

test('GET board meta 502s (not an empty-success shape) when Monday fails', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const unstub = stubMondayAuthFailure();
  try {
    await withMondayEnabled(async () => {
      const res = await app.inject({ method: 'GET', url: '/api/monday/boards/b1/meta' });
      assert.equal(res.statusCode, 502);
      const body = res.json() as { error?: string; code?: string; groups?: unknown; columns?: unknown };
      assert.match(body.error ?? '', /Not Authenticated/);
      assert.equal('groups' in body, false);
      assert.equal('columns' in body, false);
    });
  } finally {
    unstub();
    await app.close();
    db.close();
  }
});

// --- GET /api/monday/projects/:projectId/config -------------------------

test('GET project config 404s for an unknown project', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/nope/config' });
  assert.equal(res.statusCode, 404);
  await app.close();
  db.close();
});

test('GET project config returns null when the project has no Monday scope', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/config' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().config, null);
  await app.close();
  db.close();
});

test('GET project config returns the stored config', async () => {
  const db = getDb(':memory:');
  seedProjectWithMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/config' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().config.board_id, 'b1');
  await app.close();
  db.close();
});

// --- PUT /api/monday/projects/:projectId/config -------------------------

test('PUT project config 404s for an unknown project', async () => {
  const db = getDb(':memory:');
  const app = await buildApp(db);
  const res = await app.inject({ method: 'PUT', url: '/api/monday/projects/nope/config', payload: VALID_CONFIG });
  assert.equal(res.statusCode, 404);
  await app.close();
  db.close();
});

test('PUT project config persists a valid config and it round-trips through GET', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'PUT', url: '/api/monday/projects/p1/config', payload: VALID_CONFIG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().config.board_id, 'b1');

  const get = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/config' });
  assert.deepEqual(get.json().config, VALID_CONFIG);
  await app.close();
  db.close();
});

test('PUT project config rejects a missing board_id', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, board_id: '' },
  });
  assert.equal(res.statusCode, 400);
  // Assert the specific message, not just the status code: a 400 for the
  // WRONG reason (e.g. a bug that rejects every payload) would otherwise
  // still pass this test.
  assert.equal(res.json().error, 'board_id is required');
  await app.close();
  db.close();
});

test('PUT project config rejects rollup.enabled true with no column_id — the misconfiguration that later self-disables', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, rollup: { enabled: true, column_id: '', column_type: 'text' } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'rollup.column_id is required when rollup.enabled is true');
  await app.close();
  db.close();
});

test('PUT project config rejects a bad column_type', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, rollup: { enabled: true, column_id: 'text_1', column_type: 'boolean' } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "rollup.column_type must be 'text' or 'numeric'");
  await app.close();
  db.close();
});

test('PUT project config rejects a non-positive min_interval_minutes', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, updates: { enabled: true, min_interval_minutes: 0 } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'updates.min_interval_minutes must be a positive number');

  const negative = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, updates: { enabled: true, min_interval_minutes: -5 } },
  });
  assert.equal(negative.statusCode, 400);
  assert.equal(negative.json().error, 'updates.min_interval_minutes must be a positive number');
  await app.close();
  db.close();
});

test('PUT project config applies a floor to a positive-but-tiny min_interval_minutes rather than hammering Monday', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, updates: { enabled: true, min_interval_minutes: 1 } },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().config.updates.min_interval_minutes >= 5, 'a sane floor must be applied, not a raw 1-minute interval');
  await app.close();
  db.close();
});

test('PUT project config preserves sibling keys in config_json (does not clobber column_defaults)', async () => {
  const db = getDb(':memory:');
  seedProjectWithMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, board_id: 'b2' },
  });
  assert.equal(res.statusCode, 200);

  const row = db.prepare('SELECT config_json FROM projects WHERE id = ?').get('p1') as { config_json: string };
  const parsed = JSON.parse(row.config_json);
  assert.deepEqual(parsed.column_defaults, { triage: 'x1', todo: null, in_progress: null, review: null, deploy: null });
  assert.equal(parsed.monday.board_id, 'b2');
  await app.close();
  db.close();
});

test('PUT project config drops unknown keys in the monday block rather than persisting them', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, unexpected_field: 'nope', token: 'should-never-be-stored' },
  });
  assert.equal(res.statusCode, 200);

  const row = db.prepare('SELECT config_json FROM projects WHERE id = ?').get('p1') as { config_json: string };
  const parsed = JSON.parse(row.config_json);
  assert.equal(parsed.monday.unexpected_field, undefined);
  assert.equal(parsed.monday.token, undefined);
  assert.equal(JSON.stringify(row.config_json).includes('should-never-be-stored'), false);
  await app.close();
  db.close();
});

test('PUT project config refuses to clobber sibling data when config_json is unparseable', async () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES (?, ?, 'P', 'P', '', '', ?, 0, '', 'now', 'now')`)
    .run('p1', 'p1', '{not-json');
  const app = await buildApp(db);
  const res = await app.inject({ method: 'PUT', url: '/api/monday/projects/p1/config', payload: VALID_CONFIG });
  // Never a 500 (opaque crash) and never a 200 (which would mean the write
  // went through and silently dropped whatever else was in the blob).
  assert.notEqual(res.statusCode, 500);
  assert.notEqual(res.statusCode, 200);

  const row = db.prepare('SELECT config_json FROM projects WHERE id = ?').get('p1') as { config_json: string };
  // Untouched — nothing was silently destroyed.
  assert.equal(row.config_json, '{not-json');
  await app.close();
  db.close();
});

test('PUT project config refuses rather than crashing when config_json is the literal string "null"', async () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES (?, ?, 'P', 'P', '', '', ?, 0, '', 'now', 'now')`)
    .run('p1', 'p1', 'null');
  const app = await buildApp(db);
  const res = await app.inject({ method: 'PUT', url: '/api/monday/projects/p1/config', payload: VALID_CONFIG });
  // `JSON.parse('null')` succeeds and returns `null`, which passes a naive
  // `typeof === 'object'` check and then crashes assigning `.monday` — this
  // must not reach the generic framework 500.
  assert.notEqual(res.statusCode, 500);

  const row = db.prepare('SELECT config_json FROM projects WHERE id = ?').get('p1') as { config_json: string };
  assert.equal(row.config_json, 'null');
  await app.close();
  db.close();
});

test('PUT does not accept or store a token even if one is sent under a plausible key', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  await app.inject({
    method: 'PUT', url: '/api/monday/projects/p1/config',
    payload: { ...VALID_CONFIG, monday_token: 'secret-token-value' },
  });
  const row = db.prepare('SELECT config_json FROM projects WHERE id = ?').get('p1') as { config_json: string };
  assert.equal(row.config_json.includes('secret-token-value'), false);
  await app.close();
  db.close();
});

// --- Distinguishing "unconfigured" from "disabled/tokenless" on the
// existing items/search 409s (the ambiguity the frontend setup panel needs
// resolved) --------------------------------------------------------------

test('GET items 409s with code "unconfigured" when the project has no Monday scope', async () => {
  const db = getDb(':memory:');
  seedProjectWithoutMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/items' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'unconfigured');
  await app.close();
  db.close();
});

test('GET items 409s with code "monday_disabled" (not "unconfigured") when scope exists but Monday is disabled/tokenless', async () => {
  const db = getDb(':memory:');
  seedProjectWithMonday(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/items?refresh=1' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, 'monday_disabled');
  await app.close();
  db.close();
});
