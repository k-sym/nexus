import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { QuestionBroker } from '../pi/questions';
import { ApprovalBroker } from '../pi/approvals';
import { createGatewayApp, type GatewayAttentionSource } from '../gateway/server';
import { toLensAttentionItem } from '../gateway/mappers';

// The partner row as /v1/attention serves it — more than the lens needs.
const ROW = {
  id: 'att_01',
  kind: 'mail.waiting',
  status: 'open',
  title: 'Re: Method statement for the Colchester refit',
  why: 'waiting 3.2d from jane.holloway@contractor-example.co.uk',
  body: null,
  source: { account: 'ssuk' },
  links: { draft_id: null, vault_page: null, proposal_id: null },
  proposed_verb: 'draft',
  verbs: ['draft', 'open', 'snooze', 'dismiss'],
  lens_verbs: ['draft', 'snooze', 'dismiss'],
  dedup_key: 'x',
  producer: 'inbox-nudge',
  created_at: 1789470000,
  updated_at: 1789470000,
  snoozed_until: null,
  expires_at: 1789729200,
  seq: 12,
  alert_seq: 4,
  resolution: null,
};

function setup(attention?: GatewayAttentionSource) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-gw-att-'));
  const db = getDb(join(dir, 'test.db'));
  const pi = {
    questions: new QuestionBroker(),
    approvals: new ApprovalBroker(),
    readMessages: async () => [],
    setSupervised: () => {},
    isSupervised: () => false,
    listSupervised: () => [],
  } as unknown as import('../pi/runtime').PiRuntime;
  const handle = createGatewayApp({ pi, db, mainPort: 0, attention, config: { enabled: true, port: 0, token: '', recentMs: 60_000 } });
  return {
    handle,
    cleanup: async () => {
      await handle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('toLensAttentionItem keeps only what the hero shows and tolerates a partial row', () => {
  const lens = toLensAttentionItem(ROW);
  assert.deepEqual(lens, {
    id: 'att_01', kind: 'mail.waiting', title: ROW.title, why: ROW.why, status: 'open',
    proposed_verb: 'draft', verbs: ['draft', 'open', 'snooze', 'dismiss'], lens_verbs: ['draft', 'snooze', 'dismiss'],
    alert_seq: 4, created_at: 1789470000, snoozed_until: null, category: 'action',
    body: null, has_page: false, suggested_project: null,
  });
  assert.ok(!('links' in lens) && !('source' in lens) && !('events' in lens), 'the lens gets the body (D58) but never links, source or the ledger');
  const partial = toLensAttentionItem({ id: 'x', verbs: ['snooze', 7], lens_verbs: 'nope' });
  assert.equal(partial.kind, 'unknown');
  assert.deepEqual(partial.verbs, ['snooze']);
  assert.deepEqual(partial.lens_verbs, []);
  assert.equal(partial.alert_seq, 0);
  assert.equal(partial.category, 'action', 'absent category = action');
  assert.equal(toLensAttentionItem({ ...ROW, kind: 'night.summary', category: 'notice' }).category, 'notice');
  // Slice 8 (D58): what Read needs rides on the item; a blank body is null, a page is a flag.
  const rich = toLensAttentionItem({ ...ROW, kind: 'meeting.prep', body: 'Prep pack…', links: { vault_page: 'Meeting prep: IT Standup (2026-09-17)' }, suggested_project: 'ssuk' });
  assert.equal(rich.body, 'Prep pack…');
  assert.equal(rich.has_page, true);
  assert.equal(rich.suggested_project, 'ssuk');
  assert.equal(toLensAttentionItem({ ...ROW, body: '   ' }).body, null);
});

test('GET /api/attention serves the source in lens shape and is empty without one', async () => {
  const bare = setup();
  try {
    const res = await bare.handle.app.inject({ method: 'GET', url: '/api/attention' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { items: [] });
  } finally {
    await bare.cleanup();
  }

  const fed = setup({ list: async () => [toLensAttentionItem(ROW)], resolve: async () => ({ status: 200, body: {} }) });
  try {
    const res = await fed.handle.app.inject({ method: 'GET', url: '/api/attention' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().items.length, 1);
    assert.equal(res.json().items[0].lens_verbs[0], 'draft');
  } finally {
    await fed.cleanup();
  }
});

test('a partner blip fails soft on the list', async () => {
  const { handle, cleanup } = setup({ list: async () => { throw new Error('connect ECONNREFUSED'); }, resolve: async () => ({ status: 200, body: {} }) });
  try {
    const res = await handle.app.inject({ method: 'GET', url: '/api/attention' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items, []);
    assert.match(res.json().error, /ECONNREFUSED/);
  } finally {
    await cleanup();
  }
});

test('POST resolve forwards the verb and preset and passes the partner status through', async () => {
  const calls: Array<{ id: string; body: unknown }> = [];
  const { handle, cleanup } = setup({
    list: async () => [],
    resolve: async (id, body) => {
      calls.push({ id, body });
      return body.verb === 'draft' ? { status: 202, body: { ...ROW, status: 'resolving' } } : { status: 200, body: { ...ROW, status: 'snoozed' } };
    },
  });
  try {
    const snooze = await handle.app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'snooze', preset: 'tomorrow' } });
    assert.equal(snooze.statusCode, 200);
    assert.equal(snooze.json().status, 'snoozed');
    assert.deepEqual(calls[0], { id: 'att_01', body: { verb: 'snooze', preset: 'tomorrow' } });

    const draft = await handle.app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'draft' } });
    assert.equal(draft.statusCode, 202);
    assert.equal(draft.json().status, 'resolving');
    assert.deepEqual(calls[1].body, { verb: 'draft' });
  } finally {
    await cleanup();
  }
});

test('a missing verb is a 400 before the source is asked; no source is a 400 too', async () => {
  let asked = false;
  const { handle, cleanup } = setup({ list: async () => [], resolve: async () => { asked = true; return { status: 200, body: {} }; } });
  try {
    const res = await handle.app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(asked, false);
  } finally {
    await cleanup();
  }
  const bare = setup();
  try {
    const res = await bare.handle.app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'dismiss' } });
    assert.equal(res.statusCode, 400);
  } finally {
    await bare.cleanup();
  }
});

test('the partner refusing a lens verb reaches the glasses as 409 with its sentence; other failures are 502', async () => {
  const { handle, cleanup } = setup({
    list: async () => [],
    resolve: async (_id, body) => {
      if (body.verb === 'open') throw Object.assign(new Error(JSON.stringify({ detail: 'open is not allowed from the lens on this item' })), { status: 409 });
      throw new Error('socket hang up');
    },
  });
  try {
    const refused = await handle.app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'open' } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'open is not allowed from the lens on this item');
    const broken = await handle.app.inject({ method: 'POST', url: '/api/attention/att_01/resolve', payload: { verb: 'dismiss' } });
    assert.equal(broken.statusCode, 502);
  } finally {
    await cleanup();
  }
});

// Slice 8 (D59/D62/D63): the reads and the To-do, each passing the upstream status through.
test('thread and page reads pass 200 / 404 / 409 through and are absent on a gateway wired without them', async () => {
  const bare = setup({ list: async () => [], resolve: async () => ({ status: 200, body: {} }) });
  try {
    assert.equal((await bare.handle.app.inject({ method: 'GET', url: '/api/attention/att_01/thread' })).statusCode, 404);
    assert.equal((await bare.handle.app.inject({ method: 'GET', url: '/api/attention/att_01/page' })).statusCode, 404);
    assert.deepEqual((await bare.handle.app.inject({ method: 'GET', url: '/api/projects' })).json(), { projects: [] });
  } finally {
    await bare.cleanup();
  }
  const MESSAGE = { item_id: 'att_01', messages: [{ account: 'ssuk', id: 'm', thread: 'c', from: 'jane@x.com', from_name: 'Jane', subject: 'Re: PO', date: '2026-09-17T12:00:00Z', body: 'Hi Keith, any news?' }] };
  const fed = setup({
    list: async () => [],
    resolve: async () => ({ status: 200, body: {} }),
    thread: async (id) => {
      if (id === 'att_meet') throw Object.assign(new Error(JSON.stringify({ detail: 'thread applies to mail items only' })), { status: 409 });
      if (id === 'nope') throw Object.assign(new Error(JSON.stringify({ detail: 'unknown item nope' })), { status: 404 });
      return { status: 200, body: MESSAGE };
    },
    page: async (id) => (id === 'att_meet' ? { status: 200, body: { title: 'Meeting prep', body: '# Prep', item_id: id } } : { status: 404, body: { error: 'This item has no page.' } }),
  });
  try {
    const ok = await fed.handle.app.inject({ method: 'GET', url: '/api/attention/att_01/thread' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().messages[0].from_name, 'Jane');
    const refused = await fed.handle.app.inject({ method: 'GET', url: '/api/attention/att_meet/thread' });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'thread applies to mail items only');
    assert.equal((await fed.handle.app.inject({ method: 'GET', url: '/api/attention/nope/thread' })).statusCode, 404);
    const page = await fed.handle.app.inject({ method: 'GET', url: '/api/attention/att_meet/page' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().body, '# Prep');
    assert.equal((await fed.handle.app.inject({ method: 'GET', url: '/api/attention/att_01/page' })).statusCode, 404);
  } finally {
    await fed.cleanup();
  }
});

test('the To-do files through the source with the project, refuses a missing project_id first, and lists projects', async () => {
  const filed: Array<[string, string]> = [];
  const fed = setup({
    list: async () => [],
    resolve: async () => ({ status: 200, body: {} }),
    file: async (id, projectId) => {
      filed.push([id, projectId]);
      if (projectId === 'nope') throw Object.assign(new Error('Project not found'), { status: 404 });
      return { status: 200, body: { thread: { id: 'thr_1', project_id: projectId, title: 'IT Standup' }, firstTurn: 'IT Standup\n\n…' } };
    },
    projects: async () => [{ id: 'p1', slug: 'nexus', name: 'Nexus', badge: 'NEX' }],
  });
  try {
    const bad = await fed.handle.app.inject({ method: 'POST', url: '/api/attention/att_01/file', payload: {} });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(filed, []);
    const ok = await fed.handle.app.inject({ method: 'POST', url: '/api/attention/att_01/file', payload: { project_id: 'p1' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().thread.id, 'thr_1');
    assert.deepEqual(filed, [['att_01', 'p1']]);
    const missing = await fed.handle.app.inject({ method: 'POST', url: '/api/attention/att_01/file', payload: { project_id: 'nope' } });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual((await fed.handle.app.inject({ method: 'GET', url: '/api/projects' })).json(), { projects: [{ id: 'p1', slug: 'nexus', name: 'Nexus', badge: 'NEX' }] });
  } finally {
    await fed.cleanup();
  }
});
