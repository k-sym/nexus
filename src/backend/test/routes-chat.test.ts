import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PiRuntime, type PiRuntimePaths } from '../pi/runtime';
import { ConcurrencyTracker } from '../pi/concurrency';
import { registerChatRoutes } from '../routes/chat';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-chat-test-'));
  const db = new Database(join(dir, 'test.db'));
  // Minimal schema: projects + chat_threads + chat_messages. (chat_messages
  // will be dropped in Phase 5; routes still write to it for backward compat.)
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
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT DEFAULT '[]',
      message_type TEXT DEFAULT 'text',
      structured_json TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const projectId = 'proj-1';
  db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, 'demo', 'Demo', dir, new Date().toISOString(), new Date().toISOString());
  const threadId = 'thread-1';
  db.prepare(
    'INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(threadId, projectId, 'zosma', 'T1', new Date().toISOString(), new Date().toISOString());
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  const runtime = new PiRuntime(paths);
  const concurrency = new ConcurrencyTracker();
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', runtime);
  app.decorate('chatConcurrency', concurrency);
  app.register(registerChatRoutes);
  return { app, db, dir, runtime, concurrency };
}

test('POST /api/threads/:id/messages/stream returns 409 when a *different* thread in the same project is busy', async () => {
  const { app, db, dir, concurrency } = makeApp();
  try {
    concurrency.set('proj-1', 'other-thread', 'Other');
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi' },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.kind, 'project_busy');
    assert.equal(body.activeThreadId, 'other-thread');
    assert.equal(body.activeTitle, 'Other');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream returns 409 for a *different* busy thread in the same project', async () => {
  const { app, db, dir, concurrency } = makeApp();
  try {
    concurrency.set('proj-1', 'other-thread', 'Other');
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi' },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.activeThreadId, 'other-thread');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/projects/:projectId/threads creates a thread row', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/threads',
      payload: { title: 'New chat' },
    });
    assert.equal(res.statusCode, 200);
    const thread = res.json();
    assert.equal(thread.project_id, 'proj-1');
    assert.equal(thread.title, 'New chat');
    assert.ok(thread.id);
    // The placeholder agent_id is set for now (Phase 5 drops the column).
    assert.equal(thread.agent_id, 'zosma');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId returns the thread + empty messages for a fresh thread', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.thread.id, 'thread-1');
    assert.deepEqual(body.messages, []);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH /api/threads/:threadId renames the thread', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/thread-1',
      payload: { title: 'Renamed' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().title, 'Renamed');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH /api/threads/:threadId rejects empty titles', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/thread-1',
      payload: { title: '   ' },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DELETE /api/threads/:threadId removes the row', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });
    assert.equal(after.json().thread, undefined);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/projects/:projectId/threads returns threads for the project', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/projects/proj-1/threads' });
    assert.equal(res.statusCode, 200);
    const threads = res.json();
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, 'thread-1');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/abort returns no_run when nothing is in flight', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/api/threads/thread-1/abort' });
    assert.equal(res.json().ok, false);
    assert.equal(res.json().reason, 'no_run');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Avoid unused-import warning for `existsSync` (kept for future file-checks).
void existsSync;
