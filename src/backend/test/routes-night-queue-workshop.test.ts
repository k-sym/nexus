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

test('POST /api/night-queue/discuss passes the working draft through and surfaces 403', async () => {
  const seen: any[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return jsonRes({ session_id: 's-1', repo: 'quasar-scoreboard', number: 3,
                     title: 'Layout bug', url: 'u3',
                     session_title: 'night-queue: quasar-scoreboard#3' });
  });

  const body = (await app.inject({ method: 'POST', url: '/api/night-queue/discuss',
    payload: { repo: 'quasar-scoreboard', number: 3, draft: 'my working text' } })).json();
  assert.equal(body.session_id, 's-1');
  assert.equal(seen[0].url, 'http://adapter:8788/v1/night-queue/discuss');
  // The conversation starts from what is on Keith's screen, not from the
  // original assessment.
  assert.equal(seen[0].body.draft, 'my working text');

  // An absent draft is omitted rather than sent as null.
  await app.inject({ method: 'POST', url: '/api/night-queue/discuss',
                     payload: { repo: 'r', number: 1 } });
  assert.equal('draft' in seen[1].body, false);
  await app.close();
});

test('discuss keeps the adapter status and validates before calling out', async () => {
  let called = false;
  const refusing = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    called = true;
    return new Response(JSON.stringify({ detail: 'nexus never runs unattended by standing policy' }),
                        { status: 403 });
  });
  const res = await refusing.inject({ method: 'POST', url: '/api/night-queue/discuss',
                                      payload: { repo: 'nexus', number: 401 } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'nexus never runs unattended by standing policy');

  called = false;
  for (const bad of [{}, { repo: 'r' }, { repo: 'r', number: '1' }]) {
    const r = await refusing.inject({ method: 'POST', url: '/api/night-queue/discuss', payload: bad });
    assert.equal(r.statusCode, 400);
  }
  assert.equal(called, false, 'a malformed discuss must not reach the adapter');
  await refusing.close();
});

test('GET discuss/:id/comment reads by the ADAPTER session id', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url) => {
    seen.push(String(url));
    return jsonRes({ session_id: 's-1', found: true, comment: '**Goal:** agreed text' });
  });

  const body = (await app.inject({
    method: 'GET', url: '/api/night-queue/discuss/s-1/comment' })).json();
  assert.equal(body.found, true);
  assert.equal(body.comment, '**Goal:** agreed text');
  // The chat endpoints are keyed by NEXUS ids; this one is not. Sending the
  // adopted id here would read a conversation that does not exist.
  assert.equal(seen[0], 'http://adapter:8788/v1/night-queue/discuss/s-1/comment');
  await app.close();
});

test('comment: found:false travels, and 404 stays 404', async () => {
  // "There is no comment in this conversation yet" is an answer the card
  // renders; flattening it to an error would send Keith back to copy-paste.
  const empty = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ session_id: 's-1', found: false, comment: '' }));
  const body = (await empty.inject({
    method: 'GET', url: '/api/night-queue/discuss/s-1/comment' })).json();
  assert.equal(body.found, false);
  assert.equal(body.comment, '');
  assert.equal(body.error, undefined);
  await empty.close();

  const missing = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    new Response(JSON.stringify({ detail: 'no workshop conversation with that id' }),
                 { status: 404 }));
  const res = await missing.inject({
    method: 'GET', url: '/api/night-queue/discuss/nope/comment' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'no workshop conversation with that id');
  await missing.close();
});

test('arm forwards the caller\'s decided_by so the ledger says where it came from', async () => {
  // A phone tap and a desk session are the same write but not the same act,
  // and the autonomy ledger is the only place that distinction survives.
  const seen: any[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (_url, init) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')));
    return jsonRes({ repo: 'r', number: 1, queued: true, label: 'night-queue',
                     comment_posted: true, url: 'u' });
  });
  const arm = (decided_by?: unknown) => app.inject({
    method: 'POST', url: '/api/night-queue/arm',
    payload: { repo: 'r', number: 1, comment: 'z'.repeat(60), decided_by },
  });

  await arm('ios-workshop');
  assert.equal(seen[0].decided_by, 'ios-workshop');

  // Blank, whitespace and non-string values fall back to the desktop's value
  // rather than writing an empty attribution onto the ledger.
  await arm('   ');
  assert.equal(seen[1].decided_by, 'nexus-workshop');
  await arm(42);
  assert.equal(seen[2].decided_by, 'nexus-workshop');

  // Clamped like the adapter clamps it, so a long client string cannot become
  // the ledger's problem.
  await arm('x'.repeat(200));
  assert.equal(seen[3].decided_by.length, 64);
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
