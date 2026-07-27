import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import Fastify from 'fastify';
import { getDb } from '../db';
import { registerDevice } from '../devices/index.js';
import { registerDevRoutes } from '../routes/dev.js';

/** A minimal ApnsSender stub: `configured` toggles and `notify` records calls. */
function makeApnsStub(configured: boolean) {
  const calls: any[] = [];
  return {
    calls,
    stub: {
      get configured() {
        return configured;
      },
      async notify(message: any) {
        calls.push(message);
      },
    } as any,
  };
}

function makeApp(configured: boolean) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dev-routes-'));
  const db = getDb(join(dir, 'test.db'));
  const apns = makeApnsStub(configured);

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('apns', apns.stub);
  app.register(registerDevRoutes);
  return { app, db, apns, dir };
}

test('POST /api/dev/test-push reports when APNs is not configured', async () => {
  const { app } = makeApp(false);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/dev/test-push', payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'apns_not_configured');
  } finally {
    await app.close();
  }
});

test('POST /api/dev/test-push reports when there are no registered devices', async () => {
  const { app } = makeApp(true);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/dev/test-push', payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'no_registered_devices');
    assert.equal(body.deviceCount, 0);
  } finally {
    await app.close();
  }
});

test('POST /api/dev/test-push sends a push with defaults and honours overrides', async () => {
  const { app, db, apns } = makeApp(true);
  try {
    registerDevice(db, { token: 'abc123', env: 'sandbox' });

    // Defaults: badge 1, generic title/body, deep link "open:".
    let res = await app.inject({ method: 'POST', url: '/api/dev/test-push', payload: {} });
    assert.equal(res.statusCode, 200);
    let body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.deviceCount, 1);
    assert.equal(body.sent.badge, 1);
    assert.equal(apns.calls.length, 1);
    assert.equal(apns.calls[0].deepLink, 'open:');

    // Overrides flow through to the sender.
    res = await app.inject({
      method: 'POST',
      url: '/api/dev/test-push',
      payload: { title: 'Hi', body: 'There', badge: 7, deepLink: 'thread:t1' },
    });
    body = res.json();
    assert.equal(body.ok, true);
    assert.equal(apns.calls.length, 2);
    assert.deepEqual(apns.calls[1], { title: 'Hi', body: 'There', deepLink: 'thread:t1', badge: 7 });
  } finally {
    await app.close();
  }
});
