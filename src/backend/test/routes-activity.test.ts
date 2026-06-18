import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db.js';
import { ActivityManager } from '../activity/manager.js';
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
