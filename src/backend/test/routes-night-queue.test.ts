import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createNightQueueRoutes } from '../routes/night-queue';
import type { HermesFetch } from '../hermes/client';
import type { NexusConfig } from '@nexus/shared';

const REPORT = {
  available: true,
  generated_at: 1787000000,
  nights: [
    {
      id: '20260828-010000',
      started_at: '2026-08-28T01:00:00',
      started_ts: 1787000000,
      ended_at: '2026-08-28T03:00:00',
      ended_ts: 1787007200,
      stop_reason: 'max_issues',
      issues_planned: 2,
      issues_attempted: 2,
      tokens_used: 90000,
      outcome: 'worked',
      prs_opened: 2,
      unvalidated: 1,
      failures: 0,
      runs: [
        {
          id: 'r1',
          repo: 'selfie-wall',
          issue_number: 273,
          status: 'pr_opened',
          verdict: 'approve',
          tests: 'passed',
          rounds: 1,
          pr_url: 'https://github.com/k-sym/selfie-wall/pull/287',
          tokens_used: 50000,
        },
      ],
    },
  ],
  queue: [{ repo: 'selfie-wall', number: 300, title: 'Add X', excluded: false }],
  queue_error: null,
  queue_stale: false,
  open_prs: [{ repo: 'selfie-wall', number: 287, title: 'night-queue: Add X' }],
  open_prs_error: null,
  open_prs_stale: false,
};

function loadWith(url: string, key: string): () => NexusConfig {
  return () => ({ assistant: { url, api_key: key } }) as NexusConfig;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function appWith(load: () => NexusConfig, fetchImpl?: HermesFetch) {
  const app = Fastify({ logger: false });
  app.register(createNightQueueRoutes(load, { fetchImpl }));
  await app.ready();
  return app;
}

test('GET /api/night-queue proxies the board and marks configured', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    seen.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer k1');
    return jsonRes(REPORT);
  });
  const res = await app.inject({ method: 'GET', url: '/api/night-queue' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.available, true);
  assert.equal(body.nights[0].id, '20260828-010000');
  // The rollups the cards render rather than recompute must survive the hop.
  assert.equal(body.nights[0].unvalidated, 1);
  assert.equal(body.nights[0].runs[0].tests, 'passed');
  assert.equal(body.queue[0].number, 300);
  assert.equal(body.open_prs[0].number, 287);
  assert.deepEqual(seen, ['http://adapter:8788/v1/night-queue']);
  await app.close();
});

test('GET /api/night-queue passes a positive nights window and ignores junk', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url) => {
    seen.push(String(url));
    return jsonRes(REPORT);
  });
  await app.inject({ method: 'GET', url: '/api/night-queue?nights=30' });
  await app.inject({ method: 'GET', url: '/api/night-queue?nights=banana' });
  await app.inject({ method: 'GET', url: '/api/night-queue?nights=-3' });
  assert.deepEqual(seen, [
    'http://adapter:8788/v1/night-queue?nights=30',
    'http://adapter:8788/v1/night-queue',
    'http://adapter:8788/v1/night-queue',
  ]);
  await app.close();
});

test('GET /api/night-queue is fail-soft when unconfigured or unreachable', async () => {
  const unconfigured = await appWith(loadWith('', ''));
  const res = await unconfigured.inject({ method: 'GET', url: '/api/night-queue' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    configured: false,
    available: false,
    nights: [],
    queue: [],
    open_prs: [],
  });
  await unconfigured.close();

  const down = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const res2 = await down.inject({ method: 'GET', url: '/api/night-queue' });
  assert.equal(res2.statusCode, 200);
  const body = res2.json();
  assert.equal(body.configured, true);
  // An adapter we cannot reach must not read as "no night has run yet".
  assert.equal(body.available, false);
  assert.deepEqual(body.nights, []);
  assert.match(body.error, /ECONNREFUSED/);
  await down.close();
});

test('GET /api/night-queue keeps the adapter own no-ledger-yet shape', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ available: false, nights: [], queue: [{ repo: 'wise-app', number: 8 }], open_prs: [] }),
  );
  const body = (await app.inject({ method: 'GET', url: '/api/night-queue' })).json();
  assert.equal(body.available, false);
  assert.equal(body.error, undefined);
  // The queue half stands alone — it only needs the label search.
  assert.equal(body.queue[0].number, 8);
  await app.close();
});

test('GET /api/night-queue/nights/:id proxies the plan and maps 404', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url) => {
    if (String(url).endsWith('/nights/20260828-010000')) {
      return jsonRes({ ...REPORT.nights[0], plan: { selected: [{ repo: 'selfie-wall', number: 273 }], parked: [], excluded: [] } });
    }
    return new Response('night not found', { status: 404 });
  });
  const res = await app.inject({ method: 'GET', url: '/api/night-queue/nights/20260828-010000' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().plan.selected[0].number, 273);

  const missing = await app.inject({ method: 'GET', url: '/api/night-queue/nights/nope' });
  assert.equal(missing.statusCode, 404);
  await app.close();
});
