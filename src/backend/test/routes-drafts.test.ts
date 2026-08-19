import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createDraftsRoutes } from '../routes/drafts';
import type { HermesFetch } from '../hermes/client';
import type { NexusConfig } from '@nexus/shared';

const QUEUE = {
  pending: 1,
  drafts: [
    {
      id: '216ef299e734',
      account: 'ssuk',
      status: 'pending',
      subject: 'Re: Method statement for the Colchester refit',
      to: [],
      cc: [],
      reply_to: 'ssuk:AAMkAGbenign01',
      source: 'draft-replies',
      rationale: 'waiting 3.2d from jane.holloway@contractor-example.co.uk',
      preview: 'Hi Jane, thanks for the chase…',
      body_chars: 284,
    },
  ],
};

function loadWith(url: string, key: string): () => NexusConfig {
  return () => ({ assistant: { url, api_key: key } }) as NexusConfig;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function appWith(load: () => NexusConfig, fetchImpl?: HermesFetch) {
  const app = Fastify({ logger: false });
  app.register(createDraftsRoutes(load, { fetchImpl }));
  await app.ready();
  return app;
}

test('GET /api/drafts proxies the pending queue', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    seen.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer k1');
    return jsonRes(QUEUE);
  });
  const res = await app.inject({ method: 'GET', url: '/api/drafts?status=pending' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.pending, 1);
  assert.equal(body.drafts[0].account, 'ssuk');
  assert.deepEqual(seen, ['http://adapter:8788/v1/drafts?status=pending']);
  await app.close();
});

test('an unconfigured adapter yields an empty card, not an error page', async () => {
  const app = await appWith(loadWith('', ''));
  const res = await app.inject({ method: 'GET', url: '/api/drafts' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { configured: false, drafts: [], pending: 0 });
  await app.close();
});

test('an unreachable adapter degrades the read instead of 5xx-ing', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const res = await app.inject({ method: 'GET', url: '/api/drafts' });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().error, /ECONNREFUSED/);
  await app.close();
});

test('POST approve forwards the decider and reports the send', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
    return jsonRes({ id: '216ef299e734', status: 'sent', sent: true });
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/drafts/216ef299e734/approve',
    payload: { by: 'ios' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sent, true);
  assert.equal(calls[0].url, 'http://adapter:8788/v1/drafts/216ef299e734/approve');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { by: 'ios' });
  await app.close();
});

test('a bodiless approve still names a decider', async () => {
  let sent: unknown;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (_url, init) => {
    sent = init?.body && JSON.parse(String(init.body));
    return jsonRes({ sent: true });
  });
  const res = await app.inject({ method: 'POST', url: '/api/drafts/abc/approve' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sent, { by: 'nexus' });
  await app.close();
});

// The distinction that matters on the card: a second tap must not read as a
// failed send, and a failed send must not read as success.
test('an already-decided draft surfaces as 409, not 502', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ detail: "cannot approve a draft in state 'sent'" }, 409),
  );
  const res = await app.inject({ method: 'POST', url: '/api/drafts/abc/approve' });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /state 'sent'/);
  await app.close();
});

test('a failed send surfaces the reason as 502', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ detail: 'refusing to send draft abc: content changed after approval' }, 502),
  );
  const res = await app.inject({ method: 'POST', url: '/api/drafts/abc/approve' });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /content changed after approval/);
  await app.close();
});

test('reject forwards the note and does not send', async () => {
  let body: any;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    assert.match(String(url), /\/reject$/);
    body = init?.body && JSON.parse(String(init.body));
    return jsonRes({ id: 'abc', status: 'rejected' });
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/drafts/abc/reject',
    payload: { by: 'web', note: 'too formal' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'rejected');
  assert.deepEqual(body, { by: 'web', note: 'too formal' });
  await app.close();
});
