import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerTicketRoutes } from '../routes/tickets';

// Keep these tests hermetic regardless of the developer's shell: a configured
// JIRA_TOKEN (present on machines that actually run the poll) would push the
// "unconfigured" case down the live-fetch path. The route treats a missing
// token as unconfigured, so clearing it here guarantees the precondition.
delete process.env.JIRA_TOKEN;

function appWithDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-desc-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerTicketRoutes);
  return { app, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('GET description returns cleaned text from cached ADF without calling Jira', async () => {
  const { app, db, cleanup } = appWithDb();
  const adf = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cached body.' }] }],
  });
  db.prepare("INSERT INTO tickets (key, summary, synced_at, description_adf, description_fetched_at) VALUES (?, ?, ?, ?, ?)")
    .run('SUP-9', 'sum', new Date().toISOString(), adf, '2026-06-15T00:00:00.000Z');

  const res = await app.inject({ method: 'GET', url: '/api/tickets/SUP-9/description' });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.key, 'SUP-9');
  assert.equal(json.body, 'Cached body.');
  assert.equal(json.empty, false);
  await app.close();
  cleanup();
});

test('GET description 404s for an unknown ticket', async () => {
  const { app, cleanup } = appWithDb();
  const res = await app.inject({ method: 'GET', url: '/api/tickets/NOPE-1/description' });
  assert.equal(res.statusCode, 404);
  await app.close();
  cleanup();
});

test('GET description returns empty (not error) when no cache and Jira is unconfigured', async () => {
  const { app, db, cleanup } = appWithDb();
  db.prepare("INSERT INTO tickets (key, summary, synced_at) VALUES (?, ?, ?)")
    .run('SUP-5', 'sum', new Date().toISOString());
  const res = await app.inject({ method: 'GET', url: '/api/tickets/SUP-5/description' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().empty, true);
  await app.close();
  cleanup();
});
