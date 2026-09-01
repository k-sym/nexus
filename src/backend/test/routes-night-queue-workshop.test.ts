import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createWorkshopRoutes } from '../routes/night-queue-workshop';
import type { HermesFetch } from '../hermes/client';
import type { NexusConfig } from '@nexus/shared';

const CANDIDATES = {
  candidates: [
    { repo: 'quasar-scoreboard', number: 3, title: 'Layout bug', blocked: null, open_pr: null },
    { repo: 'wisesafety', number: 211, title: 'Training', blocked: 'open_pr',
      open_pr: { number: 212, url: 'u', branch: 'fix/issue-211-x', reason: 'linked' } },
    { repo: 'nexus', number: 401, title: 'Stats', blocked: 'excluded', open_pr: null },
  ],
  unblocked: 1,
  generated_at: 1787000000,
};

const ASSESSMENT = {
  repo: 'quasar-scoreboard', number: 3, ready: false, assessed: true,
  summary: 'Needs an acceptance check.',
  criteria: [{ id: 'acceptance', label: 'Verifiable acceptance check', status: 'missing', note: 'none named' }],
  draft_comment: '**Goal:** x\n**Acceptance checks:** <TODO: name one>',
};

function loadWith(url: string, key: string): () => NexusConfig {
  return () => ({ assistant: { url, api_key: key } }) as NexusConfig;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function appWith(load: () => NexusConfig, fetchImpl?: HermesFetch) {
  const app = Fastify({ logger: false });
  app.register(createWorkshopRoutes(load, { fetchImpl }));
  await app.ready();
  return app;
}

test('GET /api/night-queue/candidates passes blocked rows through, reasons intact', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () => jsonRes(CANDIDATES));
  const body = (await app.inject({ method: 'GET', url: '/api/night-queue/candidates' })).json();
  assert.equal(body.configured, true);
  assert.equal(body.candidates.length, 3);
  // Blocked candidates must survive the hop: the view greys them out rather
  // than hiding them, so the reason has to arrive.
  assert.equal(body.candidates[1].blocked, 'open_pr');
  assert.equal(body.candidates[1].open_pr.number, 212);
  assert.equal(body.candidates[2].blocked, 'excluded');
  assert.equal(body.unblocked, 1);
  await app.close();
});

test('reads are fail-soft when unconfigured or unreachable', async () => {
  const un = await appWith(loadWith('', ''));
  assert.deepEqual((await un.inject({ method: 'GET', url: '/api/night-queue/candidates' })).json(),
    { configured: false, candidates: [] });
  assert.deepEqual((await un.inject({ method: 'GET', url: '/api/night-queue/readiness' })).json(),
    { configured: false, criteria: [] });
  await un.close();

  const down = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const body = (await down.inject({ method: 'GET', url: '/api/night-queue/candidates' })).json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.candidates, []);
  assert.match(body.error, /ECONNREFUSED/);
  await down.close();
});

test('GET /api/night-queue/readiness carries the verbatim bar', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ criteria: [{ id: 'outcome', label: 'Stated outcome', requirement: 'x', conditional: null }],
              bar_text: 'READINESS BAR — ...', excluded_repos: ['baker-internal', 'nexus'] }));
  const body = (await app.inject({ method: 'GET', url: '/api/night-queue/readiness' })).json();
  assert.equal(body.criteria[0].id, 'outcome');
  assert.match(body.bar_text, /READINESS BAR/);
  await app.close();
});

test('POST /api/night-queue/assess proxies the verdict and validates input', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () => jsonRes(ASSESSMENT));
  const body = (await app.inject({ method: 'POST', url: '/api/night-queue/assess',
                                   payload: { repo: 'quasar-scoreboard', number: 3 } })).json();
  assert.equal(body.ready, false);
  assert.match(body.draft_comment, /<TODO/);

  for (const bad of [{}, { repo: 'x' }, { number: 3 }, { repo: 'x', number: '3' }]) {
    const r = await app.inject({ method: 'POST', url: '/api/night-queue/assess', payload: bad });
    assert.equal(r.statusCode, 400);
  }
  await app.close();
});

test('an unreadable assessment surfaces as an error, never as an empty verdict', async () => {
  // "I could not judge this" must not render as "nothing is wrong with it".
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    new Response(JSON.stringify({ detail: 'the assessment did not come back as JSON' }), { status: 502 }));
  const res = await app.inject({ method: 'POST', url: '/api/night-queue/assess',
                                 payload: { repo: 'x', number: 1 } });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /did not come back as JSON/);
  await app.close();
});

test('POST /api/night-queue/arm passes the adapter status through unflattened', async () => {
  // The view branches on these: 403 is standing policy, 409 already queued,
  // 400 a spec the adapter refused. Collapsing them to 502 would turn four
  // different conversations into one shrug.
  const cases: Array<[number, string]> = [
    [403, 'nexus never runs unattended by standing policy'],
    [409, 'this issue is already queued'],
    [400, 'the readiness comment still contains an unresolved <TODO: …>'],
  ];
  for (const [status, detail] of cases) {
    const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
      new Response(JSON.stringify({ detail }), { status }));
    const res = await app.inject({ method: 'POST', url: '/api/night-queue/arm',
                                   payload: { repo: 'r', number: 1, comment: 'x'.repeat(50) } });
    assert.equal(res.statusCode, status, detail);
    // And the FastAPI envelope is unwrapped, so the card shows prose not JSON.
    assert.equal(res.json().error, detail);
    await app.close();
  }
});

test('POST /api/night-queue/arm returns the armed result and names the decision', async () => {
  const seen: any[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return jsonRes({ repo: 'quasar-scoreboard', number: 3, queued: true, label: 'night-queue',
                     comment_posted: true, url: 'https://github.com/k-sym/quasar-scoreboard/issues/3',
                     decision: { class: 'night-queue-arm:quasar-scoreboard', recorded: true, promotable: false } });
  });
  const body = (await app.inject({ method: 'POST', url: '/api/night-queue/arm',
    payload: { repo: 'quasar-scoreboard', number: 3, comment: 'y'.repeat(60) } })).json();
  assert.equal(body.queued, true);
  assert.equal(body.decision.promotable, false);
  assert.equal(seen[0].url, 'http://adapter:8788/v1/night-queue/arm');
  // Stamped so the ledger records where the decision came from.
  assert.equal(seen[0].body.decided_by, 'nexus-workshop');
  await app.close();
});

test('arm validates its input before reaching the adapter', async () => {
  let called = false;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    called = true;
    return jsonRes({});
  });
  for (const bad of [{}, { repo: 'r' }, { repo: 'r', number: 1 }, { repo: 'r', number: 1, comment: 5 }]) {
    const r = await app.inject({ method: 'POST', url: '/api/night-queue/arm', payload: bad });
    assert.equal(r.statusCode, 400);
  }
  assert.equal(called, false, 'a malformed arm must not reach the write path');
  await app.close();
});
