import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerOrchestratorRoutes } from '../routes/orchestrator';

interface SeedRun {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

function makeApp(activeProviders: string[], runs: SeedRun[]) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-usage-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'triage',
      model_key TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT,
      source TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL,
      output TEXT DEFAULT '',
      error TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);

  const now = new Date().toISOString();
  for (const [i, run] of runs.entries()) {
    db.prepare(
      `INSERT INTO agent_runs
         (id, status, provider, model, prompt_tokens, completion_tokens, total_tokens, duration_ms, started_at, completed_at)
       VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `run-${i}`,
      run.provider,
      run.model,
      run.prompt_tokens,
      run.completion_tokens,
      run.total_tokens,
      1000,
      now,
      now,
    );
  }

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', { auth: { list: () => activeProviders } } as any);
  app.register(registerOrchestratorRoutes);
  return { app, db, dir };
}

test('GET /api/agents/usage drops providers without current auth (the Hermes fix)', async () => {
  const { app, db, dir } = makeApp(
    ['anthropic', 'openrouter'],
    [
      { provider: 'hermes', model: 'hermes-1', prompt_tokens: 900_000, completion_tokens: 500_000, total_tokens: 1_400_000 },
      { provider: 'anthropic', model: 'sonnet', prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      { provider: 'openrouter', model: 'auto', prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
    ],
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/api/agents/usage' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.totals.runs, 2, 'hermes run excluded from totals');
    assert.equal(body.totals.total_tokens, 1800, 'hermes tokens excluded from totals');
    assert.equal(body.totals.prompt_tokens, 1200);
    assert.equal(body.totals.completion_tokens, 600);

    const providers = body.byProvider.map((p: any) => p.provider).sort();
    assert.deepEqual(providers, ['anthropic', 'openrouter'], 'byProvider excludes hermes');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/agents/usage returns zero totals when no providers have auth', async () => {
  const { app, db, dir } = makeApp(
    [],
    [
      { provider: 'hermes', model: 'hermes-1', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      { provider: 'anthropic', model: 'sonnet', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    ],
  );
  try {
    const res = await app.inject({ method: 'GET', url: '/api/agents/usage' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.totals.runs, 0);
    assert.equal(body.totals.total_tokens, 0);
    assert.deepEqual(body.byProvider, []);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
