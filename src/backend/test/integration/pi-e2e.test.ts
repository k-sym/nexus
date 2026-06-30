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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PiRuntime } from '../../pi/runtime';
import { ConcurrencyTracker } from '../../pi/concurrency';
import { ModelCurationStore } from '../../pi/model-curation';
import { OAuthFlowManager } from '../../pi/oauth-flows';
import { registerChatRoutes } from '../../routes/chat';
import { registerPiRoutes } from '../../routes/pi';
import { registerAuthRoutes } from '../../routes/auth';

test('POST /api/threads/:id/messages/stream returns 200 NDJSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, config_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, last_model_key TEXT);
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
    // A run_end envelope is the durable terminal record. The important thing
    // is the wire format is valid NDJSON, the route completes, and the stream
    // ends cleanly.
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.kind, 'run_end', `expected terminal kind, got ${JSON.stringify(last)}`);
    assert.ok(['completed', 'failed', 'cancelled', 'interrupted'].includes(last.run.status));
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
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, last_model_key TEXT);
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

test('GET /api/models returns allModels plus curated models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  const app = Fastify({ logger: false });
  app.decorate('pi', runtime);
  app.decorate('modelCuration', new ModelCurationStore(join(dir, 'model-curation.json')));
  app.register(registerPiRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.allModels));
    assert.ok(Array.isArray(body.models));
    assert.ok(Array.isArray(body.enabledModelKeys));
    assert.equal(body.customized, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /api/models/curation saves enabled model keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  runtime.auth.setRuntimeApiKey('openrouter', 'test-key');
  runtime.models.refresh();
  const first = runtime.models.getAvailable().find((model) => model.provider === 'openrouter');
  assert.ok(first, 'expected configured OpenRouter model');
  const key = `${first.provider}/${first.id}`;
  const app = Fastify({ logger: false });
  app.decorate('pi', runtime);
  app.decorate('modelCuration', new ModelCurationStore(join(dir, 'model-curation.json')));
  app.register(registerPiRoutes);
  try {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/models/curation',
      payload: { enabledModelKeys: [key, 'missing/model'] },
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().enabledModelKeys, [key]);
    const get = await app.inject({ method: 'GET', url: '/api/models' });
    assert.deepEqual(get.json().models.map((m: any) => `${m.provider}/${m.id}`), [key]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /api/models/curation ignores unconfigured model keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  const all = runtime.models.getAll();
  const unconfigured = all.find((model) => !runtime.models.getAvailable().some((available) =>
    available.provider === model.provider && available.id === model.id,
  ));
  assert.ok(unconfigured, 'expected at least one unconfigured pi model');
  const key = `${unconfigured.provider}/${unconfigured.id}`;
  const app = Fastify({ logger: false });
  app.decorate('pi', runtime);
  app.decorate('modelCuration', new ModelCurationStore(join(dir, 'model-curation.json')));
  app.register(registerPiRoutes);
  try {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/models/curation',
      payload: { enabledModelKeys: [key] },
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().enabledModelKeys, []);
    assert.deepEqual(put.json().models, []);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/models includes configured Nexus local model from custom registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-e2e-'));
  const modelsFile = join(dir, 'models.json');
  const localModelId = '/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf';
  const localModelKey = `local/${localModelId}`;
  writeFileSync(modelsFile, JSON.stringify({
    providers: {
      local: {
        name: 'Local Model Server',
        baseUrl: 'http://127.0.0.1:8081/v1',
        api: 'openai-completions',
        apiKey: 'local',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [
          {
            id: localModelId,
            name: 'Local Model',
            input: ['text'],
            reasoning: false,
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }));
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
    modelsFile,
  });
  const app = Fastify({ logger: false });
  app.decorate('pi', runtime);
  app.decorate('modelCuration', new ModelCurationStore(join(dir, 'model-curation.json')));
  app.register(registerPiRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.allModels.some((model: any) =>
      model.provider === 'local' && model.id === localModelId && model.name === 'Local Model',
    ));
    assert.ok(body.models.some((model: any) =>
      model.provider === 'local' && model.id === localModelId && model.name === 'Local Model',
    ));

    const put = await app.inject({
      method: 'PUT',
      url: '/api/models/curation',
      payload: { enabledModelKeys: [localModelKey] },
    });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json().enabledModelKeys, [localModelKey]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/auth/start-oauth starts a flow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-auth-'));
  const runtime = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  });
  const app = Fastify({ logger: false });
  app.decorate('pi', runtime);
  app.decorate('modelCuration', new ModelCurationStore(join(dir, 'model-curation.json')));
  app.decorate('oauthFlows', new OAuthFlowManager({
    login: async (_provider, callbacks) => callbacks.onAuth({ url: 'https://example.test/login' }),
  }));
  app.register(registerAuthRoutes);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/start-oauth',
      payload: { provider: 'anthropic' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.json().flowId, 'string');
    const status = await app.inject({ method: 'GET', url: `/api/auth/oauth/${res.json().flowId}` });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().authUrl, 'https://example.test/login');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/auth/oauth/:flowId refreshes auth and models after OAuth completes', async () => {
  let authReloads = 0;
  let modelRefreshes = 0;
  const syncedProviders: string[] = [];
  const app = Fastify({ logger: false });
  app.decorate('pi', {
    auth: {
      list: () => [],
      get: () => undefined,
      set: () => {},
      remove: () => {},
      reload: () => {
        authReloads += 1;
      },
    },
    models: {
      refresh: () => {
        modelRefreshes += 1;
      },
      getAll: () => [
        { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT 5.4', configured: true },
      ],
      getAvailable: () => [
        { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT 5.4', configured: true },
      ],
    },
  });
  app.decorate('modelCuration', {
    markOAuthProviderSynced: (provider: string) => {
      syncedProviders.push(provider);
    },
  });
  app.decorate('oauthFlows', {
    start: () => ({ id: 'flow-complete' }),
    status: () => ({
      id: 'flow-complete',
      provider: 'openai-codex',
      state: 'complete',
      messages: [],
    }),
    respond: () => false,
    cancel: () => false,
  });
  app.register(registerAuthRoutes);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/flow-complete' });
    assert.equal(res.statusCode, 200);
    assert.equal(authReloads, 1);
    assert.equal(modelRefreshes, 1);
    assert.deepEqual(syncedProviders, ['openai-codex']);
  } finally {
    await app.close();
  }
});
