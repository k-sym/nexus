import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db.js';
import { ActivityManager } from '../activity/manager.js';
import { OPERATION_KINDS } from '../activity/events.js';
import { registerActivityRoutes } from '../routes/activity.js';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-activity-route-test-'));
  const db = getDb(join(dir, 'test.db'));
  const activity = new ActivityManager(db);
  activity.startListening();

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('activity', activity);
  app.decorate('activeChatStreams', new Map());
  app.register(registerActivityRoutes);
  return { app, db, dir, activity };
}

test('GET /api/activity returns running and recent operations', async () => {
  const { app, dir, activity } = makeApp();
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-1', kind: 'jira_sync', title: 'Jira sync' });
    activity.bus.emit({ type: 'start', operationId: 'op-2', kind: 'github_sync', title: 'GitHub sync' });
    activity.bus.emit({ type: 'stop', operationId: 'op-2', kind: 'github_sync', title: 'GitHub sync', status: 'succeeded' });

    const res = await app.inject({ method: 'GET', url: '/api/activity' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.running.length, 1);
    assert.equal(body.running[0].id, 'op-1');
    assert.equal(body.recent.length, 1);
    assert.equal(body.recent[0].id, 'op-2');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/activity applies status filter before limiting recent operations', async () => {
  const { app, dir, activity, db } = makeApp();
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-run', kind: 'jira_sync', title: 'Jira sync' });
    activity.bus.emit({ type: 'start', operationId: 'op-success', kind: 'github_sync', title: 'GitHub sync' });
    activity.bus.emit({ type: 'stop', operationId: 'op-success', kind: 'github_sync', title: 'GitHub sync', status: 'succeeded' });
    activity.bus.emit({ type: 'start', operationId: 'op-failed', kind: 'memory_archive', title: 'Archive' });
    activity.bus.emit({ type: 'stop', operationId: 'op-failed', kind: 'memory_archive', title: 'Archive', status: 'failed', error: 'embedder unreachable' });

    db.prepare("UPDATE operations SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = 'op-failed'").run();
    db.prepare("UPDATE operations SET started_at = '2026-01-02T00:00:00.000Z' WHERE id = 'op-success'").run();

    const res = await app.inject({ method: 'GET', url: '/api/activity?status=failed&limit=1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.running, []);
    assert.equal(body.recent.length, 1);
    assert.equal(body.recent[0].id, 'op-failed');
    assert.deepEqual(body.counts, { failed: 1 });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The route used to hand-maintain its own list of filterable kinds, which
// silently fell out of step when monday_sync/monday_write/mission_tick were
// added: an unrecognised kind is treated as "no filter", so ?kind=monday_sync
// returned every operation instead of erroring. Deriving both sides from
// OPERATION_KINDS makes that drift impossible; this pins it.
test('GET /api/activity filters by every declared operation kind', async () => {
  const { app, dir, activity } = makeApp();
  try {
    for (const [i, kind] of OPERATION_KINDS.entries()) {
      activity.bus.emit({ type: 'start', operationId: `op-${i}`, kind, title: kind });
      activity.bus.emit({ type: 'stop', operationId: `op-${i}`, kind, title: kind, status: 'succeeded' });
    }

    for (const kind of OPERATION_KINDS) {
      const res = await app.inject({ method: 'GET', url: `/api/activity?kind=${kind}` });
      assert.equal(res.statusCode, 200);
      const kinds = [...new Set(res.json().recent.map((r: { kind: string }) => r.kind))];
      assert.deepEqual(kinds, [kind], `?kind=${kind} should return only ${kind}`);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/activity/:id/diagnostics returns parsed diagnostics', async () => {
  const { app, dir, activity } = makeApp();
  try {
    activity.bus.emit({
      type: 'start',
      operationId: 'op-diag',
      kind: 'memory_archive',
      title: 'Archive',
      diagnostics: { memoryId: 'mem-1' },
    });
    activity.bus.emit({ type: 'stop', operationId: 'op-diag', kind: 'memory_archive', title: 'Archive', status: 'succeeded' });

    const res = await app.inject({ method: 'GET', url: '/api/activity/op-diag/diagnostics' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.diagnostics.memoryId, 'mem-1');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/activity/:id/abort returns 409 for unsupported kind', async () => {
  const { app, dir, activity } = makeApp();
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-sync', kind: 'jira_sync', title: 'Jira sync' });

    const res = await app.inject({ method: 'POST', url: '/api/activity/op-sync/abort' });
    assert.equal(res.statusCode, 409);
    assert.ok(res.json().error.includes('Abort not supported'));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/activity/:id/retry returns 409 for unsupported kind', async () => {
  const { app, dir, activity } = makeApp();
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-chat', kind: 'chat_turn', title: 'Chat' });
    activity.bus.emit({ type: 'stop', operationId: 'op-chat', kind: 'chat_turn', title: 'Chat', status: 'succeeded' });

    const res = await app.inject({ method: 'POST', url: '/api/activity/op-chat/retry' });
    assert.equal(res.statusCode, 409);
    assert.ok(res.json().error.includes('Retry not supported'));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Monday kinds route to their own retry endpoints ------------------------

/** Stand-ins for the two Monday endpoints the retry route injects into,
 *  registered on the same app so `fastify.inject` reaches them. */
function withMondayStubs(app: ReturnType<typeof makeApp>['app'], seen: { url: string; body: unknown }[]) {
  app.post('/api/monday/refresh', async () => { seen.push({ url: '/api/monday/refresh', body: null }); return { ok: true, refreshed: 3 }; });
  app.post('/api/monday/items/:itemId/retry-writes', async (request) => {
    seen.push({ url: request.url, body: request.body });
    return { ok: true, feed: 'nothing' };
  });
}

test('POST /api/activity/:id/retry re-runs a monday_sync via the refresh endpoint', async () => {
  const { app, dir, activity } = makeApp();
  const seen: { url: string; body: unknown }[] = [];
  withMondayStubs(app, seen);
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-ms', kind: 'monday_sync', title: 'Monday refresh' });
    activity.bus.emit({ type: 'stop', operationId: 'op-ms', kind: 'monday_sync', title: 'Monday refresh', status: 'failed', error: 'rate limit' });
    const res = await app.inject({ method: 'POST', url: '/api/activity/op-ms/retry' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, refreshed: 3 });
    assert.equal(seen[0].url, '/api/monday/refresh');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/activity/:id/retry re-runs a monday_write for the item recorded in its diagnostics', async () => {
  const { app, dir, activity } = makeApp();
  const seen: { url: string; body: unknown }[] = [];
  withMondayStubs(app, seen);
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-mw', kind: 'monday_write', title: 'Monday roll-up', projectId: 'p1', taskId: 't1', diagnostics: { itemId: 'item-9' } });
    activity.bus.emit({ type: 'stop', operationId: 'op-mw', kind: 'monday_write', title: 'Monday roll-up', status: 'failed', error: 'boom' });
    const res = await app.inject({ method: 'POST', url: '/api/activity/op-mw/retry' });
    assert.equal(res.statusCode, 200);
    assert.equal(seen[0].url, '/api/monday/items/item-9/retry-writes');
    assert.deepEqual(seen[0].body, { project_id: 'p1' });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/activity/:id/retry explains a monday_write that recorded no item id instead of failing opaquely', async () => {
  const { app, dir, activity } = makeApp();
  withMondayStubs(app, []);
  try {
    activity.bus.emit({ type: 'start', operationId: 'op-old', kind: 'monday_write', title: 'Monday roll-up', projectId: 'p1' });
    activity.bus.emit({ type: 'stop', operationId: 'op-old', kind: 'monday_write', title: 'Monday roll-up', status: 'failed', error: 'boom' });
    const res = await app.inject({ method: 'POST', url: '/api/activity/op-old/retry' });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /no item id recorded/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
