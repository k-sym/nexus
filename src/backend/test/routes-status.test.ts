import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerStatusRoutes } from '../routes/status';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-status-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', {
    models: {
      getAll: () => [
        { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        { provider: 'openrouter', id: 'gpt-5', name: 'GPT-5' },
        { provider: 'openrouter', id: 'llama', name: 'Llama' },
      ],
      getAvailable: () => [
        { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      ],
    },
  });
  app.decorate('modelCuration', {
    apply: (models: any[]) => ({
      allModels: models,
      models: models.filter((model) => model.provider === 'anthropic'),
    }),
  });
  app.register(registerStatusRoutes);
  return {
    app,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('GET /api/mission-control omits dashboard activity rows', async () => {
  const { app, db, cleanup } = makeApp();
  try {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('project-1', 'project-1', 'Project 1', '/tmp', now, now);
    db.prepare(
      'INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('task-1', 'project-1', 'Task-backed run', now, now);
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, source, status, provider, model, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-task', 'task-1', 'project-1', 'task', 'completed', 'codex', 'codex-default', '2026-06-15T10:00:00.000Z', now);
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, project_id, source, status, provider, model, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-chat', null, 'project-1', 'chat', 'completed', 'claude', 'sonnet', '2026-06-15T11:00:00.000Z', now);

    const res = await app.inject({ method: 'GET', url: '/api/mission-control' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(Object.hasOwn(body, 'activity'), false);
    assert.deepEqual(body.modelCounts, { active: 1, available: 3 });
  } finally {
    await app.close();
    cleanup();
  }
});
