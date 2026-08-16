import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createRoutinesRoutes } from '../routes/routines';
import type { HermesFetch } from '../hermes/client';
import type { NexusConfig } from '@nexus/shared';

const REPORT = {
  routines: [
    {
      name: 'morning-brief',
      label: 'com.k-sym.partner.morning-brief',
      schedule: [{ hour: 7, minute: 5 }],
      schedule_display: 'daily 07:05',
      last_run: { started: 1786000000, ended: 1786000060, rc: 0, timed_out: false, source: 'status' },
      health: 'ok',
      last_expected: 1786000000,
      next_due: 1786086400,
    },
  ],
  generated_at: 1786000100,
};

function loadWith(url: string, key: string): () => NexusConfig {
  return () => ({ assistant: { url, api_key: key } }) as NexusConfig;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function appWith(load: () => NexusConfig, fetchImpl?: HermesFetch) {
  const app = Fastify({ logger: false });
  app.register(createRoutinesRoutes(load, { fetchImpl }));
  await app.ready();
  return app;
}

test('GET /api/routines proxies the adapter report and marks configured', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    seen.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer k1');
    return jsonRes(REPORT);
  });
  const res = await app.inject({ method: 'GET', url: '/api/routines' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.routines[0].name, 'morning-brief');
  assert.equal(body.routines[0].health, 'ok');
  assert.equal(body.generated_at, REPORT.generated_at);
  assert.deepEqual(seen, ['http://adapter:8788/v1/routines']);
  await app.close();
});

test('GET /api/routines is fail-soft when unconfigured or unreachable', async () => {
  const unconfigured = await appWith(loadWith('', ''));
  const res = await unconfigured.inject({ method: 'GET', url: '/api/routines' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { configured: false, routines: [] });
  await unconfigured.close();

  const down = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const res2 = await down.inject({ method: 'GET', url: '/api/routines' });
  assert.equal(res2.statusCode, 200);
  const body = res2.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.routines, []);
  assert.match(body.error, /ECONNREFUSED/);
  await down.close();
});

test('GET /api/routines/:name proxies detail with log tail and maps 404', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url) => {
    const name = String(url).split('/').pop();
    if (name === 'morning-brief') return jsonRes({ ...REPORT.routines[0], log_tail: ['line 1', 'line 2'] });
    return new Response('routine not found', { status: 404 });
  });
  const res = await app.inject({ method: 'GET', url: '/api/routines/morning-brief' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().log_tail, ['line 1', 'line 2']);

  const missing = await app.inject({ method: 'GET', url: '/api/routines/nope' });
  assert.equal(missing.statusCode, 404);

  await app.close();
});
