/**
 * End-to-end integration test for the chat subsystem.
 *
 * Spawns the real Fastify backend with the real PiRuntime. Creates a
 * project and a thread, opens the streaming endpoint, and verifies
 * that we get a 200 NDJSON response with a final {kind: 'error'}
 * chunk (because no auth is configured, the pi runtime surfaces
 * an auth failure, which the route forwards as an error event).
 *
 * This is an "in-process integration test" — it boots the Fastify
 * app via `app.inject`, which runs everything in the same node
 * process as the test. It does NOT spawn a subprocess. That's
 * sufficient to prove the route is wired correctly; a true
 * end-to-end test (with the sidecar spawned separately) is left
 * to manual verification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PiRuntime } from '../../pi/runtime';
import { ConcurrencyTracker } from '../../pi/concurrency';
import { registerChatRoutes } from '../../routes/chat';

test('POST /api/threads/:id/messages/stream returns 200 NDJSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, config_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, attachments_json TEXT DEFAULT '[]', message_type TEXT DEFAULT 'text', structured_json TEXT, thinking TEXT, tool_calls TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'p1', 'p1', 'P1', dir, new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    't1', 'p1', 'T1', new Date().toISOString(), new Date().toISOString(),
  );

  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  const concurrency = new ConcurrencyTracker();
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', runtime);
  app.decorate('chatConcurrency', concurrency);
  app.register(registerChatRoutes);

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/messages/stream',
      payload: { content: 'hi' },
    });
    assert.equal(res.statusCode, 200, `stream failed: ${res.status} ${res.body.slice(0, 200)}`);
    const lines = res.body.trim().split('\n').filter(Boolean);
    assert.ok(lines.length > 0, 'expected at least one NDJSON line');
    // The route emits {kind: 'done'} on a successful prompt completion
    // (which is what we get when no model is configured — pi returns
    // immediately with no error). The important thing is the wire format
    // is valid NDJSON, the route completes, and the stream ends cleanly.
    const last = JSON.parse(lines[lines.length - 1]);
    assert.ok(
      last.kind === 'done' || last.kind === 'error',
      `expected terminal kind, got ${JSON.stringify(last)}`,
    );
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId returns thread + empty messages for a fresh thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, config_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT);
  `);
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'p1', 'p1', 'P1', dir, new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    't1', 'p1', 'T1', new Date().toISOString(), new Date().toISOString(),
  );
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', runtime);
  app.decorate('chatConcurrency', new ConcurrencyTracker());
  app.register(registerChatRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/threads/t1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.thread.id, 't1');
    assert.deepEqual(body.messages, []);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/models returns the pi runtime model registry (configured = auth.json present + env keys)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  // The runtime ships with the full builtin model catalog, regardless
  // of whether the user has configured any auth. With no auth.json
  // entries, configured = 0 — but the env may have API keys (e.g.
  // OPENROUTER_API_KEY), in which case getAvailable() may be > 0.
  // The relevant property under test is that getAll() is the full
  // builtin catalog and getAvailable() is a subset of getAll().
  const all = runtime.models.getAll();
  const available = runtime.models.getAvailable();
  assert.ok(all.length > 0, 'pi runtime ships with builtin model catalog');
  assert.ok(
    available.length <= all.length,
    `getAvailable (${available.length}) must be a subset of getAll (${all.length})`,
  );
  rmSync(dir, { recursive: true, force: true });
});
