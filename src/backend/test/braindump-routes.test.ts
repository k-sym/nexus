import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerBraindumpRoutes } from '../routes/braindump';

function appWithDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-brain-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerBraindumpRoutes);
  return { app, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('create, list, edit, and triage-removal of ideas', async () => {
  const { app, cleanup } = appWithDb();

  const created = await app.inject({ method: 'POST', url: '/api/braindump', payload: { title: 'Idea one' } });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  assert.equal(created.json().status, 'active');

  const listed = await app.inject({ method: 'GET', url: '/api/braindump' });
  assert.equal(listed.json().length, 1);

  const edited = await app.inject({ method: 'PATCH', url: `/api/braindump/${id}`, payload: { body: 'more detail' } });
  assert.equal(edited.json().body, 'more detail');

  // Triaged ideas drop out of the active list.
  await app.inject({ method: 'PATCH', url: `/api/braindump/${id}`, payload: { status: 'triaged', project_id: 'p1', task_id: 't1' } });
  const afterTriage = await app.inject({ method: 'GET', url: '/api/braindump' });
  assert.equal(afterTriage.json().length, 0);

  await app.close();
  cleanup();
});

test('delete removes an idea', async () => {
  const { app, cleanup } = appWithDb();
  const created = await app.inject({ method: 'POST', url: '/api/braindump', payload: { title: 'Doomed' } });
  const id = created.json().id;
  const del = await app.inject({ method: 'DELETE', url: `/api/braindump/${id}` });
  assert.equal(del.statusCode, 200);
  const listed = await app.inject({ method: 'GET', url: '/api/braindump' });
  assert.equal(listed.json().length, 0);
  await app.close();
  cleanup();
});

test('POST rejects an empty title', async () => {
  const { app, cleanup } = appWithDb();
  const res = await app.inject({ method: 'POST', url: '/api/braindump', payload: { title: '   ' } });
  assert.equal(res.statusCode, 400);
  await app.close();
  cleanup();
});
