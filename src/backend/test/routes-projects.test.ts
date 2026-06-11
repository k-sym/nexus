import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerProjectRoutes } from '../routes/projects';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-routes-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent TEXT,
      due_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  const insertProject = db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertProject.run('project-a', 'alpha', 'Alpha', dir, 0, now, now);
  insertProject.run('project-b', 'beta', 'Beta', dir, 1, now, now);
  insertProject.run('project-c', 'charlie', 'Charlie', dir, 2, now, now);

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerProjectRoutes);
  return { app, db, dir };
}

test('PUT /api/projects/order persists the sidebar project order', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/order',
      payload: { project_ids: ['project-c', 'project-a', 'project-b'] },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().map((p: { id: string }) => p.id), ['project-c', 'project-a', 'project-b']);

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.deepEqual(list.json().map((p: { id: string }) => p.id), ['project-c', 'project-a', 'project-b']);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
