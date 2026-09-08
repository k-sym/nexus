import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerTicketRoutes } from '../routes/tickets';

// See tickets-description-route.test.ts: a live JIRA_TOKEN would push the draft's
// description refresh down the network path.
delete process.env.JIRA_TOKEN;

const adf = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reports show 8AOFI; last score missing.' }] }] });

function appWithDb(generate?: (system: string, prompt: string) => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ticket-session-'));
  const db = getDb(join(dir, 'test.db'));
  const events: unknown[] = [];
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('activity', { bus: { emit: (e: unknown) => events.push(e) } });
  app.register(registerTicketRoutes, generate ? { generate } : {});
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at, description) VALUES ('p-wse', 'wse', 'WSE', '/tmp/wse', ?, ?, 'PHP API')").run(now, now);
  db.prepare("INSERT INTO tickets (key, summary, url, synced_at, description_adf, description_fetched_at) VALUES ('SUP-123', 'Scoring wrong on reports', 'https://x.atlassian.net/browse/SUP-123', ?, ?, ?)").run(now, adf, now);
  db.prepare("INSERT INTO tickets (key, summary, synced_at) VALUES ('SUP-124', 'Other', ?)").run(now);
  return { app, db, events, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('draft returns a parsed TicketDraft from the injected generator and records an operation', async () => {
  let prompt = '';
  const { app, events, cleanup } = appWithDb(async (_s, p) => {
    prompt = p;
    return '{"problem":"The last score is missing from recent reports (8AOFI).","project":"WSE","branchType":"fix","branchDescription":"last score missing"}';
  });
  const res = await app.inject({ method: 'POST', url: '/api/tickets/SUP-123/draft' });
  assert.equal(res.statusCode, 200, res.body);
  const json = res.json();
  assert.equal(json.projectId, 'p-wse');
  assert.equal(json.branchName, 'fix/SUP123-last-score-missing');
  assert.equal(json.model, 'claude-code/claude-sonnet-5');
  assert.match(prompt, /8AOFI/);
  assert.match(prompt, /p-wse — WSE — PHP API/);
  assert.deepEqual(events.map((e: any) => [e.type, e.kind, e.status]), [['start', 'ticket_draft', undefined], ['stop', 'ticket_draft', 'succeeded']]);
  await app.close(); cleanup();
});

test('draft 404s an unknown ticket and 502s an unusable reply', async () => {
  const { app, cleanup } = appWithDb(async () => 'I cannot help with that.');
  assert.equal((await app.inject({ method: 'POST', url: '/api/tickets/NOPE-1/draft' })).statusCode, 404);
  const res = await app.inject({ method: 'POST', url: '/api/tickets/SUP-123/draft' });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /nothing usable/);
  await app.close(); cleanup();
});

test('session creates a ticket-stamped thread and composes the first turn', async () => {
  const { app, db, cleanup } = appWithDb();
  const res = await app.inject({
    method: 'POST', url: '/api/tickets/SUP-123/session',
    payload: { projectId: 'p-wse', problem: 'Fix the missing last score on reports. Look in audit_build.php.', branchName: 'fix/SUP123-last-score' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { thread, firstTurn } = res.json();
  assert.equal(thread.project_id, 'p-wse');
  assert.equal(thread.ticket_key, 'SUP-123');
  assert.equal(thread.title, 'SUP-123 Scoring wrong on reports');
  assert.ok(firstTurn.startsWith('Fix the missing last score on reports. Look in audit_build.php.'));
  assert.match(firstTurn, /Jira ticket SUP-123 \(https:\/\/x\.atlassian\.net\/browse\/SUP-123\)/);
  assert.match(firstTurn, /`fix\/SUP123-last-score`/);
  assert.match(firstTurn, /Do not touch Jira/);
  const row = db.prepare('SELECT ticket_key, project_id FROM chat_threads WHERE id = ?').get(thread.id) as any;
  assert.deepEqual(row, { ticket_key: 'SUP-123', project_id: 'p-wse' });

  // The list now shows the session on that ticket and null on the other.
  const list = (await app.inject({ method: 'GET', url: '/api/tickets' })).json();
  const byKey = Object.fromEntries(list.map((t: any) => [t.key, t.session]));
  assert.deepEqual(byKey['SUP-123'], { thread_id: thread.id, project_id: 'p-wse' });
  assert.equal(byKey['SUP-124'], null);
  await app.close(); cleanup();
});

test('session validates its inputs', async () => {
  const { app, cleanup } = appWithDb();
  const bad = (payload: object) => app.inject({ method: 'POST', url: '/api/tickets/SUP-123/session', payload });
  assert.equal((await bad({ projectId: 'p-wse', problem: '', branchName: 'fix/x' })).statusCode, 400);
  assert.equal((await bad({ projectId: 'p-wse', problem: 'x', branchName: '' })).statusCode, 400);
  assert.equal((await bad({ projectId: 'missing', problem: 'x', branchName: 'fix/x' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tickets/NOPE/session', payload: { projectId: 'p-wse', problem: 'x', branchName: 'fix/x' } })).statusCode, 404);
  await app.close(); cleanup();
});
