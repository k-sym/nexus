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
  });
  assert.ok(!('body' in lens) && !('links' in lens) && !('source' in lens));
  const partial = toLensAttentionItem({ id: 'x', verbs: ['snooze', 7], lens_verbs: 'nope' });
  assert.equal(partial.kind, 'unknown');
  assert.deepEqual(partial.verbs, ['snooze']);
  assert.deepEqual(partial.lens_verbs, []);
  assert.equal(partial.alert_seq, 0);
  assert.equal(partial.category, 'action', 'absent category = action');
  assert.equal(toLensAttentionItem({ ...ROW, kind: 'night.summary', category: 'notice' }).category, 'notice');
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
