import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerChatRoutes } from '../routes/chat';
import { buildModelCatalog } from '../routes/pi';
import { ConcurrencyTracker } from '../pi/concurrency';
import { EngineRegistry } from '../engines/registry';
import { capabilitiesFromModel } from '../pi/model-capabilities';
import type { ChatEngine, EngineSession } from '../engines/types';

function fakeEngine(id: 'pi' | 'claude-code', provider: string, prompts: string[]): ChatEngine {
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async (text: string) => { prompts.push(`${id}:${text}`); },
    abort: async () => {},
  } as unknown as EngineSession;
  const model = { provider, id: 'm1', name: 'M1', input: ['text'] as Array<'text' | 'image'>, configured: true };
  return {
    id,
    listModels: () => [model],
    findModel: (p, m) => (p === provider && m === 'm1' ? model : undefined),
    sessionFor: async () => session,
    hasSession: () => false,
    dropSession: () => {},
  };
}

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-route-'));
  const db = new Database(join(dir, 'nexus.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, last_model_key TEXT);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, attachments_json TEXT, message_type TEXT, structured_json TEXT, thinking TEXT, tool_calls TEXT, created_at TEXT);
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('proj-1', 'demo', 'Demo', dir, now, now);
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('thread-1', 'proj-1', 'T1', now, now);
  // A second thread on the same project: a thread is pinned to the engine of
  // its first turn, so each engine needs its own thread.
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('thread-2', 'proj-1', 'T2', now, now);
  const prompts: string[] = [];
  const pi = fakeEngine('pi', 'openrouter', prompts);
  const claude = fakeEngine('claude-code', 'claude-code', prompts);
  const runtime = {
    readMessages: async () => [],
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    isSupervised: () => false,
    models: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', runtime as any);
  app.decorate('chatConcurrency', new ConcurrencyTracker());
  app.decorate('engines', new EngineRegistry([pi, claude]));
  app.register(registerChatRoutes, {
    detectGitBranch: async () => 'main',
    capabilityResolver: { peek: capabilitiesFromModel, resolve: async (m: any) => capabilitiesFromModel(m) },
  });
  await app.ready();
  return { app, db, dir, prompts };
}

test('the chat route opens the session on the engine that owns the model key', async () => {
  const { app, db, dir, prompts } = await makeApp();
  try {
    const claude = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'hello', modelKey: 'claude-code/m1' } });
    assert.equal(claude.statusCode, 200);
    const pi = await app.inject({ method: 'POST', url: '/api/threads/thread-2/messages/stream', payload: { content: 'again', modelKey: 'openrouter/m1' } });
    assert.equal(pi.statusCode, 200);
    assert.deepEqual(prompts, ['claude-code:hello', 'pi:again']);
    const unknown = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'x', modelKey: 'claude-code/nope' } });
    assert.equal(unknown.statusCode, 400);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the model catalog lists every engine when the registry is present', async () => {
  const { app, db, dir } = await makeApp();
  try {
    const catalog = buildModelCatalog(app as any);
    assert.deepEqual(catalog.map((m) => `${m.provider}/${m.id}`), ['openrouter/m1', 'claude-code/m1']);
    assert.ok(catalog.every((m) => m.configured === true));
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thread is pinned to the engine of its first turn', async () => {
  const { app, db, dir } = await makeApp();
  try {
    const send = (modelKey: string) => app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'hi', modelKey } });
    assert.equal((await send('openrouter/m1')).statusCode, 200);

    const switched = await send('claude-code/m1');
    assert.equal(switched.statusCode, 409);
    const body = switched.json() as any;
    assert.equal(body.kind, 'engine_mismatch');
    assert.match(body.error, /started with the pi engine/);
    assert.match(body.error, /claude-code/);

    assert.equal((await send('openrouter/m1')).statusCode, 200, 'the same engine keeps working');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thread last used on a now-hidden anthropic/* model still counts as the pi engine', async () => {
  const { app, db, dir } = await makeApp();
  try {
    db.prepare('UPDATE chat_threads SET last_model_key = ? WHERE id = ?').run('anthropic/claude-fable-5', 'thread-1');
    const res = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'x', modelKey: 'claude-code/m1' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().kind, 'engine_mismatch');
    const ok = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'x', modelKey: 'openrouter/m1' } });
    assert.equal(ok.statusCode, 200);
  } finally {
    await app.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('confirm-cancel waits out a Claude turn interrupt grace instead of 409-ing', async () => {
  const { app, db, dir } = await makeApp();
  try {
    const concurrency = (app as any).chatConcurrency;
    const owner = concurrency.claimProject('proj-1', 'thread-2', 'T2', 'chat', 'claude-code/m1');
    assert.ok(owner);
    // The Claude session gives `interrupt()` a 2 s grace before hard-killing,
    // so the claim is released well after the Pi-sized 200 ms grace.
    const release = setTimeout(() => { concurrency.releaseProject('proj-1', owner); }, 600);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      headers: { 'x-confirm-cancel': 'true' },
      payload: { content: 'mine now', modelKey: 'claude-code/m1' },
    });
    clearTimeout(release);
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
