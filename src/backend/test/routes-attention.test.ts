import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createAttentionRoutes } from '../routes/attention';
import type { PartnerFetch } from '../partner/client';
import type { NexusConfig } from '@nexus/shared';

const ITEM = {
  id: 'att_01',
  kind: 'mail.waiting',
  status: 'open',
  title: 'Re: Method statement for the Colchester refit',
  why: 'waiting 3.2d from jane.holloway@contractor-example.co.uk',
  body: null,
  source: { producer: 'inbox-nudge', account: 'ssuk', conversation: 'AAMk01' },
  links: { draft_id: null, vault_page: null, proposal_id: null },
  proposed_verb: 'draft',
  verbs: ['draft', 'open', 'snooze', 'dismiss'],
  lens_verbs: ['draft', 'snooze', 'dismiss'],
  created_at: 1789470000,
  updated_at: 1789470000,
  snoozed_until: null,
  expires_at: 1789729200,
  seq: 12,
  alert_seq: 4,
  resolution: null,
};

const LIST = { items: [ITEM], open: 1, seq: 12, alert_seq: 4, generated_at: 1789470100 };

function loadWith(url: string, key: string): () => NexusConfig {
  return () => ({ assistant: { url, api_key: key } }) as NexusConfig;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function appWith(load: () => NexusConfig, fetchImpl?: PartnerFetch) {
  const app = Fastify({ logger: false });
  app.register(createAttentionRoutes(load, { fetchImpl }));
  await app.ready();
  return app;
}

test('GET /api/attention proxies the live list with the bearer', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    seen.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer k1');
    return jsonRes(LIST);
  });
  const res = await app.inject({ method: 'GET', url: '/api/attention?status=live' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.open, 1);
  assert.equal(body.alert_seq, 4);
  assert.equal(body.items[0].kind, 'mail.waiting');
  assert.deepEqual(seen, ['http://adapter:8788/v1/attention?status=live']);
  await app.close();
});

test('since_seq is forwarded and a bare list asks for the partner default', async () => {
  const seen: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url) => {
    seen.push(String(url));
    return jsonRes(LIST);
  });
  await app.inject({ method: 'GET', url: '/api/attention?status=open&since_seq=10' });
  await app.inject({ method: 'GET', url: '/api/attention' });
  assert.deepEqual(seen, [
    'http://adapter:8788/v1/attention?status=open&since_seq=10',
    'http://adapter:8788/v1/attention',
  ]);
  await app.close();
});

test('an unconfigured adapter yields an empty card, not an error page', async () => {
  const app = await appWith(loadWith('', ''));
  const res = await app.inject({ method: 'GET', url: '/api/attention' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { configured: false, items: [], open: 0, seq: 0, alert_seq: 0 });
  await app.close();
});

test('an unreachable adapter degrades the read instead of 5xx-ing', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const res = await app.inject({ method: 'GET', url: '/api/attention' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.deepEqual(body.items, []);
  assert.match(body.error, /ECONNREFUSED/);
  await app.close();
});

test('GET /api/attention/:id passes a 404 through and turns other failures into 502', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url) =>
    String(url).endsWith('/v1/attention/gone') ? jsonRes({ detail: 'unknown item gone' }, 404) : jsonRes({}, 500),
  );
  const missing = await app.inject({ method: 'GET', url: '/api/attention/gone' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'unknown item gone');
  const broken = await app.inject({ method: 'GET', url: '/api/attention/att_01' });
  assert.equal(broken.statusCode, 502);
  await app.close();
});

test('GET /api/attention/:id returns the detail with its events', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ ...ITEM, events: [{ verb: 'post', by: 'inbox-nudge', surface: 'producer', ts: 1789470000, result: null }] }),
  );
  const res = await app.inject({ method: 'GET', url: '/api/attention/att_01' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().events.length, 1);
  await app.close();
});

test('POST resolve forwards verb, decider and surface, and answers with the partner status', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
    return jsonRes({ ...ITEM, status: 'snoozed', snoozed_until: 1789516800 });
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/attention/att_01/resolve',
    payload: { verb: 'snooze', by: 'ios', surface: 'phone', preset: 'tomorrow' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'snoozed');
  assert.equal(calls[0].url, 'http://adapter:8788/v1/attention/att_01/resolve');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { verb: 'snooze', by: 'ios', surface: 'phone', preset: 'tomorrow' });
  await app.close();
});

// The one distinction the drafts proxy cannot make: a draft verb that has
// started is a 202 with the item in `resolving`, and the phone polls from there.
test('a 202 from the partner reaches the client as 202 with the resolving item', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ ...ITEM, status: 'resolving' }, 202),
  );
  const res = await app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'draft' } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().status, 'resolving');
  await app.close();
});

test('a bodiless-by resolve still names a decider and passes until through', async () => {
  let sent: any;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (_url, init) => {
    sent = init?.body && JSON.parse(String(init.body));
    return jsonRes(ITEM);
  });
  const res = await app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'snooze', until: 1789516800.7 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sent, { verb: 'snooze', by: 'nexus', until: 1789516800 });
  await app.close();
});

test('a missing verb is a 400 before any upstream call', async () => {
  let called = false;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () => {
    called = true;
    return jsonRes(ITEM);
  });
  const res = await app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { by: 'ios' } });
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test('a verb the state refuses surfaces as 409 with the partner sentence, not 502', async () => {
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ detail: 'item is resolved' }, 409),
  );
  const res = await app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'dismiss' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'item is resolved');
  await app.close();
});

test('a partner 400 and 404 pass through; anything else is 502', async () => {
  const statuses = [400, 404, 500];
  let i = 0;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async () =>
    jsonRes({ detail: `status ${statuses[i]}` }, statuses[i++]),
  );
  const seen: number[] = [];
  for (let n = 0; n < statuses.length; n++) {
    const res = await app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'open' } });
    seen.push(res.statusCode);
  }
  assert.deepEqual(seen, [400, 404, 502]);
  await app.close();
});

test('an unconfigured adapter refuses a write with 400', async () => {
  const app = await appWith(loadWith('', ''));
  const res = await app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'dismiss' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});
