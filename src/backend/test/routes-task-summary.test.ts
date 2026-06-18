import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerProjectRoutes } from '../routes/projects';
import { extractAssistantText } from '../memory/summarize';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-task-summary-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      description TEXT DEFAULT '', repo_path TEXT NOT NULL, config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium', assigned_agent TEXT, due_date TEXT,
      model_key TEXT, thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, level TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, seen_at TEXT
    );
  `);

  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('project-a', 'alpha', 'Alpha', dir, 0, now, now);

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  // Stub the pi runtime — a thread with no on-disk session yields no messages.
  app.decorate('pi', { readMessages: async () => [] } as any);
  app.register(registerProjectRoutes);
  return { app, db, dir };
}

function insertTask(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const t = {
    id: 'task-1', project_id: 'project-a', title: 'Wire the thing', description: '',
    status: 'in_progress', priority: 'medium', model_key: null, thread_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, model_key, thread_id, created_at, updated_at)
     VALUES (@id, @project_id, @title, @description, @status, @priority, @model_key, @thread_id, '${now}', '${now}')`,
  ).run(t);
  return t;
}

test('extractAssistantText pulls assistant text blocks and ignores user/tool messages', () => {
  const rawToolSpam = `SECRET_LOG_SPAM\n${'passing output\n'.repeat(2000)}`;
  const entries = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'I decided to use a queue.' },
      { type: 'toolCall', name: 'Edit' },
    ] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: rawToolSpam }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  const extracted = extractAssistantText(entries);
  assert.equal(extracted, 'I decided to use a queue.\n\nDone.');
  assert.doesNotMatch(extracted, /SECRET_LOG_SPAM/);
});

test('PUT /api/tasks/:id persists thread_id, model_key and status on the in_progress transition', async () => {
  const { app, db, dir } = makeApp();
  try {
    insertTask(db, { status: 'todo' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/task-1',
      payload: { status: 'in_progress', thread_id: 'thread-9', model_key: 'anthropic/sonnet-4-5' },
    });
    assert.equal(res.statusCode, 200);
    const row = res.json();
    assert.equal(row.status, 'in_progress');
    assert.equal(row.thread_id, 'thread-9');
    assert.equal(row.model_key, 'anthropic/sonnet-4-5');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moving a thread-linked task into review with an empty thread is a graceful no-op (no notification)', async () => {
  const { app, db, dir } = makeApp();
  try {
    insertTask(db, { status: 'in_progress', thread_id: 'thread-9', model_key: 'anthropic/sonnet-4-5' });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/task-1',
      payload: { status: 'review' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'review');
    // Let the fire-and-forget summarize settle.
    await new Promise((r) => setTimeout(r, 50));
    const notifs = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    assert.equal(notifs.n, 0, 'empty thread produces nothing to summarize');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
