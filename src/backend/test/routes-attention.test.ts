import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '../db';
import { createAttentionRoutes } from '../routes/attention';
import { buildAttentionFirstTurn, attentionThreadTitle } from '../attention/file';
import { parseAttentionOrigin } from '../routes/board';
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

async function appWith(load: () => NexusConfig, fetchImpl?: PartnerFetch, options: { searchPages?: (t: string) => Promise<any[]>; db?: ReturnType<typeof getDb> } = {}) {
  const app = Fastify({ logger: false });
  if (options.db) app.decorate('db', options.db);
  app.register(createAttentionRoutes(load, { fetchImpl, searchPages: options.searchPages }));
  await app.ready();
  return app;
}

const MEETING = {
  ...ITEM,
  id: 'att_meet',
  kind: 'meeting.prep',
  title: 'IT Standup and Review — Thu 17 Sep 09:30',
  why: 'Tomorrow 09:30, 5 others — prep pack in the vault; anything to tweak?',
  proposed_verb: 'open',
  verbs: ['open', 'snooze', 'dismiss'],
  lens_verbs: ['dismiss'],
  links: { draft_id: null, vault_page: 'Meeting prep: IT Standup and Review (2026-09-17)', proposal_id: null },
};

const PAGE = { id: '01M2HW', title: 'Meeting prep: IT Standup and Review (2026-09-17)', body: '# Meeting prep\n\n*WHO*\nJon Austin — …' };

/** A partner stub that answers the detail call for MEETING and records resolves. */
function partnerFor(item: Record<string, unknown>, resolves: unknown[] = []): PartnerFetch {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith('/resolve')) {
      resolves.push(init?.body && JSON.parse(String(init.body)));
      return jsonRes({ ...item, status: 'resolved' });
    }
    if (u.endsWith(`/v1/attention/${item.id}`)) return jsonRes(item);
    return jsonRes({ detail: 'unknown item' }, 404);
  };
}

function dbWithProject(id = 'proj-1') {
  const db = getDb(':memory:');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'ssuk', 'SSUK', '', '/tmp/ssuk', '{}', 0, '', now, now);
  return db;
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

// -- slice 6a: Show the page ------------------------------------------------

test('GET /api/attention/:id/page returns the vault page matched by exact title', async () => {
  const asked: string[] = [];
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), partnerFor(MEETING), {
    searchPages: async (t) => { asked.push(t); return [{ id: 'x', title: 'Meeting prep: IT Standup (2026-09-01)', body: 'older' }, PAGE]; },
  });
  const res = await app.inject({ method: 'GET', url: '/api/attention/att_meet/page' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().title, PAGE.title);
  assert.equal(res.json().body, PAGE.body);
  assert.equal(res.json().memory_id, '01M2HW');
  assert.deepEqual(asked, [MEETING.links.vault_page]);
  await app.close();
});

test('a page lookup says so when the item has no page, when the vault lacks it, and when the daemon is down', async () => {
  const noLink = await appWith(loadWith('http://adapter:8788', 'k1'), partnerFor(ITEM), { searchPages: async () => [PAGE] });
  const a = await noLink.inject({ method: 'GET', url: '/api/attention/att_01/page' });
  assert.equal(a.statusCode, 404);
  assert.match(a.json().error, /no page/);
  await noLink.close();

  const missing = await appWith(loadWith('http://adapter:8788', 'k1'), partnerFor(MEETING), { searchPages: async () => [{ id: 'y', title: 'Something else', body: 'no' }] });
  const b = await missing.inject({ method: 'GET', url: '/api/attention/att_meet/page' });
  assert.equal(b.statusCode, 404);
  assert.match(b.json().error, /No page titled/);
  await missing.close();

  const down = await appWith(loadWith('http://adapter:8788', 'k1'), partnerFor(MEETING), { searchPages: async () => { throw new Error('connect ECONNREFUSED 4100'); } });
  const c = await down.inject({ method: 'GET', url: '/api/attention/att_meet/page' });
  assert.equal(c.statusCode, 502);
  assert.match(c.json().error, /daemon unavailable/);
  await down.close();
});

// -- slice 6a: File as a to-do -----------------------------------------------

test('POST /api/attention/:id/file creates a Board session with the item as its origin and dismisses the item', async () => {
  const resolves: any[] = [];
  const db = dbWithProject();
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), partnerFor(MEETING, resolves), { db });
  const res = await app.inject({ method: 'POST', url: '/api/attention/att_meet/file', payload: { project_id: 'proj-1', by: 'ios', surface: 'phone' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.thread.project_id, 'proj-1');
  assert.equal(body.thread.title, 'IT Standup and Review — Thu 17 Sep 09:30');
  assert.match(body.firstTurn, /^IT Standup and Review — Thu 17 Sep 09:30\n\nTomorrow 09:30/);
  assert.match(body.firstTurn, /Source: partner attention item att_meet — meeting prep \(account ssuk\); vault page "Meeting prep: IT Standup and Review \(2026-09-17\)"\. Filed from the phone as a to-do\./);
  assert.match(body.firstTurn, /Do not send mail, write to GitHub, Monday or Jira/);

  const row = db.prepare('SELECT title, attention_item FROM chat_threads WHERE id = ?').get(body.thread.id) as { title: string; attention_item: string };
  assert.deepEqual(JSON.parse(row.attention_item), { id: 'att_meet', kind: 'meeting.prep', title: 'IT Standup and Review — Thu 17 Sep 09:30' });
  assert.deepEqual(parseAttentionOrigin(row.attention_item), { kind: 'attention', item_id: 'att_meet', item_kind: 'meeting.prep', title: 'IT Standup and Review — Thu 17 Sep 09:30' });
  assert.deepEqual(resolves, [{ verb: 'dismiss', by: 'ios', surface: 'phone' }]);
  await app.close();
  db.close();
});

test('filing refuses a missing project_id or an unknown project before touching the partner, and survives a refused dismiss', async () => {
  const db = dbWithProject();
  let partnerCalls = 0;
  const app = await appWith(loadWith('http://adapter:8788', 'k1'), async (url, init) => {
    partnerCalls += 1;
    if (String(url).endsWith('/resolve')) return jsonRes({ detail: 'item is resolved' }, 409);
    return jsonRes(MEETING);
  }, { db });
  const noProject = await app.inject({ method: 'POST', url: '/api/attention/att_meet/file', payload: {} });
  assert.equal(noProject.statusCode, 400);
  const unknown = await app.inject({ method: 'POST', url: '/api/attention/att_meet/file', payload: { project_id: 'nope' } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(partnerCalls, 0);

  const filed = await app.inject({ method: 'POST', url: '/api/attention/att_meet/file', payload: { project_id: 'proj-1' } });
  assert.equal(filed.statusCode, 200, 'a 409 on the dismiss does not undo the filing');
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM chat_threads').get() as { c: number }).c, 1);
  await app.close();
  db.close();
});

test('the to-do first turn and title degrade gracefully for a bare item', () => {
  const bare = { id: 'x', kind: 'future.kind', title: '  ' };
  assert.equal(attentionThreadTitle(bare), 'Needs you: future.kind');
  const turn = buildAttentionFirstTurn(bare);
  assert.match(turn, /^Needs you: future.kind\n\nSource: partner attention item x — future.kind\. Filed from the phone as a to-do\./);
  assert.equal(parseAttentionOrigin('not json'), null);
  assert.equal(parseAttentionOrigin('{"kind":"x"}'), null);
});

