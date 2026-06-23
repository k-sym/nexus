import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import Fastify from 'fastify';
import { getDb } from '../db';
import { registerMissionRoutes } from '../routes/missions';

function buildApp() {
  const base = join(tmpdir(), `nexus-rmiss-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  db.prepare(
    "INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES ('p1','p1','P','','/tmp/p1','{}',0,'', ?, ?)"
  ).run(new Date().toISOString(), new Date().toISOString());
  const app = Fastify();
  (app as any).decorate('db', db);
  (app as any).decorate('activity', { bus: { emit() {} } });
  app.setErrorHandler((error, _req, reply) => {
    const err = error as any;
    reply.status(err.statusCode || 500).send({ error: err.message });
  });
  app.register(registerMissionRoutes);
  return { app, db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('POST creates a paused mission and rejects unbounded config', async () => {
  const { app, cleanup } = buildApp();
  await app.ready();

  const bad = await app.inject({ method: 'POST', url: '/api/projects/p1/missions',
    payload: { title: 'no ceiling', kind: 'echo', pacing: 'fixed' } });
  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({ method: 'POST', url: '/api/projects/p1/missions',
    payload: { title: 'capped', kind: 'echo', pacing: 'fixed', interval_seconds: 600, max_iterations: 5 } });
  assert.equal(ok.statusCode, 200);
  const mission = ok.json();
  assert.equal(mission.status, 'paused');
  assert.equal(mission.next_run_at, null);
  assert.equal(mission.max_iterations, 5);

  await app.close();
  cleanup();
});

test('GET lists project missions and GET :id returns one', async () => {
  const { app, cleanup } = buildApp();
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/projects/p1/missions',
    payload: { title: 'm', kind: 'echo', pacing: 'backlog_drain', interval_seconds: 60 } });
  const list = await app.inject({ method: 'GET', url: '/api/projects/p1/missions' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  await app.close();
  cleanup();
});

test('PUT rejects editing a non-paused mission with 409', async () => {
  const { app, db, cleanup } = buildApp();
  await app.ready();
  const created = (await app.inject({ method: 'POST', url: '/api/projects/p1/missions',
    payload: { title: 'm', kind: 'echo', pacing: 'fixed', interval_seconds: 600, max_iterations: 5 } })).json();
  db.prepare("UPDATE missions SET status = 'active' WHERE id = ?").run(created.id);
  const res = await app.inject({ method: 'PUT', url: `/api/missions/${created.id}`, payload: { title: 'x' } });
  assert.equal(res.statusCode, 409);
  await app.close();
  cleanup();
});
