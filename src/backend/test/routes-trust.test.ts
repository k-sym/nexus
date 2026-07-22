import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import type { NexusConfig } from '@nexus/shared';
import { PiRuntime } from '../pi/runtime.js';
import { registerTrustRoutes } from '../routes/trust.js';
import { DaemonRequestError } from '../memory/client.js';

function config(root: string): NexusConfig {
  return {
    server: { port: 4173 },
    models: {
      openrouter: { api_key: '${OPENROUTER_API_KEY}' },
      local: {
        base_url: 'http://127.0.0.1:4001/v1',
        api_key: 'literal-local-secret',
        display_name: 'Local Model',
        chat_model: '',
        supports_images: false,
        embedding_model: '',
        rerank_model: '',
      },
    },
    assistant: { url: 'https://assistant.example/v1', api_key: '${ASSISTANT_API_KEY}' },
    signal_filters: { enabled: true, min_input_bytes: 1, max_output_bytes: 2, filters: { ansi: true, progress: true, repeated_lines: true, package_manager: true, test_output: true, stack_trace: true, diff_context: true }, projects: {} },
    memory: { daemon_url: 'http://127.0.0.1:4100' },
    obsidian: { vault_path: join(root, 'vault'), sync_interval_seconds: 30 },
    jira: { enabled: true, user: 'user@example.com', instance: 'acme.atlassian.net', project: 'SUP', poll_minutes: 15, content_rules: [] },
    github: { enabled: true },
    monday: { enabled: false, api_version: '2026-07', poll_minutes: 10 },
  };
}

async function fixture(options: { daemon?: any; githubSource?: any; config?: NexusConfig; pi?: any } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-'));
  const pi = await PiRuntime.create({ authFile: join(root, 'auth.json'), sessionsDir: join(root, 'sessions') });
  await pi.auth.login('anthropic', 'api_key', { prompt: async () => 'pi-secret', notify: () => {} });
  const app = Fastify();
  app.decorate('pi', options.pi ?? pi);
  await app.register(registerTrustRoutes, {
    config: () => options.config ?? config(root),
    daemonClient: options.daemon ?? {
      rebuildIndex: async () => ({ scanned: 1, inserted: 0, updated: 1, noop: 0, removed: 0, reindexed: 1, queued: 0 }),
      clearNexusMemory: async () => ({ namespace: 'nexus', deleted: 1, failed: 0, paths: ['Memories/a.md'], failures: [] }),
    },
    snapshot: { githubStatus: async () => options.githubSource ?? ({ configured: true, source: 'gh-cli' }) },
  });
  return { app, root };
}

test('trust snapshot labels sources without serializing secrets', async () => {
  process.env.JIRA_TOKEN = 'jira-secret';
  process.env.OPENROUTER_API_KEY = 'openrouter-secret';
  process.env.ASSISTANT_API_KEY = 'assistant-secret';
  process.env.GITHUB_TOKEN = 'github-secret';
  const { app, root } = await fixture();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.secrets.jira.source, 'environment');
    assert.equal(body.secrets.openrouter.source, 'config-env-reference');
    assert.equal(body.secrets.localModel.source, 'config-literal');
    assert.equal(body.secrets.assistant.source, 'config-env-reference');
    assert.equal(body.secrets.github.source, 'gh-cli');
    assert.deepEqual(body.secrets['pi:anthropic'], { configured: true, source: 'pi-auth-file', location: join(root, 'auth.json'), credentialType: 'api_key' });
    for (const secret of ['jira-secret', 'openrouter-secret', 'assistant-secret', 'github-secret', 'literal-local-secret', 'pi-secret']) {
      assert.equal(response.body.includes(secret), false);
    }
    assert.equal(body.memory.archive.mode, 'manual');
    assert.equal(body.memory.archive.destination, 'nexus');
    assert.deepEqual(body.memory.namespaces, ['nexus', 'global']);
    assert.equal(body.memory.archive.removesHotThreadAfterSuccess, true);
    assert.equal(body.telemetry.applicationTelemetry, false);
    assert.deepEqual(
      body.outbound.find((item: any) => item.name === 'Pi provider: anthropic'),
      {
        name: 'Pi provider: anthropic',
        destination: 'Provider-managed API endpoint',
        sends: ['prompts', 'conversation content', 'tool results', 'recalled memory'],
        enabled: true,
      },
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.JIRA_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ASSISTANT_API_KEY;
    delete process.env.GITHUB_TOKEN;
  }
});

test('trust snapshot reports absent config references and GitHub fallback metadata', async () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ASSISTANT_API_KEY;
  const { app, root } = await fixture({ githubSource: { configured: false, source: 'absent' } });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/trust' })).json();
    assert.deepEqual(body.secrets.openrouter, { configured: false, source: 'config-env-reference' });
    assert.deepEqual(body.secrets.github, { configured: false, source: 'absent' });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trust snapshot redacts credentials and query strings from reported URLs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-config-'));
  const configured = config(root) as NexusConfig & { memory: NexusConfig['memory'] & { models: { gen_url: string } } };
  configured.memory.daemon_url = 'http://user:daemon-secret@127.0.0.1:4100/?token=daemon-secret';
  configured.memory.models = { gen_url: 'http://127.0.0.1:4001/v1?api_key=model-secret' };
  configured.assistant.url = 'https://assistant.example/v1?key=assistant-url-secret';
  configured.jira.instance = 'https://jira-user:jira-password@acme.atlassian.net/path?token=jira-query-secret';
  const { app, root: fixtureRoot } = await fixture({ config: configured });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.equal(response.statusCode, 200);
    for (const secret of ['daemon-secret', 'model-secret', 'assistant-url-secret', 'jira-password', 'jira-query-secret']) {
      assert.equal(response.body.includes(secret), false);
    }
    assert.equal(response.json().outbound.find((item: any) => item.name === 'Assistant').destination, 'https://assistant.example/v1');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('trust snapshot discloses configured chat and memory model destinations with accurate boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-outbound-'));
  const configured = config(root) as NexusConfig & { memory: NexusConfig['memory'] & {
    models: { gen_url: string; embed_url: string; rerank_url: string };
  } };
  configured.models.local.base_url = 'https://chat-user:chat-secret@models.example/v1?key=chat-query-secret';
  configured.memory.models = {
    gen_url: 'https://memory.example/generate?key=gen-secret',
    embed_url: 'https://memory.example/embed?key=embed-secret',
    rerank_url: 'https://memory.example/rerank?key=rerank-secret',
  };
  const { app, root: fixtureRoot } = await fixture({ config: configured });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.equal(response.statusCode, 200);
    const outbound = response.json().outbound;
    assert.deepEqual(outbound.find((item: any) => item.name === 'Remote chat model endpoint'), {
      name: 'Remote chat model endpoint',
      destination: 'https://models.example/v1',
      sends: ['prompts', 'conversation content', 'tool results', 'recalled memory'],
      enabled: true,
    });
    assert.deepEqual(outbound.find((item: any) => item.name === 'Remote memory generation endpoint'), {
      name: 'Remote memory generation endpoint',
      destination: 'https://memory.example/generate',
      sends: ['memory content', 'retrieval queries'],
      enabled: true,
    });
    assert.deepEqual(outbound.find((item: any) => item.name === 'Remote memory embedding endpoint'), {
      name: 'Remote memory embedding endpoint',
      destination: 'https://memory.example/embed',
      sends: ['memory content', 'retrieval queries'],
      enabled: true,
    });
    assert.deepEqual(outbound.find((item: any) => item.name === 'Remote memory reranking endpoint'), {
      name: 'Remote memory reranking endpoint',
      destination: 'https://memory.example/rerank',
      sends: ['retrieval queries', 'candidate memory content'],
      enabled: true,
    });
    for (const secret of ['chat-secret', 'chat-query-secret', 'gen-secret', 'embed-secret', 'rerank-secret']) {
      assert.equal(response.body.includes(secret), false);
    }
    assert.equal(response.json().services.some((item: any) => item.name === 'Local generation model'), false);
    assert.equal(response.json().services.some((item: any) => item.name === 'Remote memory generation endpoint'), true);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('trust snapshot reports effective expanded daemon paths, model defaults, and URL override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-effective-'));
  const configured = config(root) as NexusConfig & { memory: NexusConfig['memory'] & { vault_path: string; db_path: string } };
  configured.obsidian.vault_path = '~/wrong-vault';
  configured.models.local.base_url = 'http://127.0.0.1:4999/v1';
  configured.memory.vault_path = '~/effective-vault';
  configured.memory.db_path = '~/indexes/effective.db';
  process.env.MEMORY_DAEMON_URL = 'http://localhost:4200?token=hidden';
  const { app, root: fixtureRoot } = await fixture({ config: configured });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/trust' })).json();
    assert.equal(body.services.find((item: any) => item.name === 'Memory daemon').url, 'http://localhost:4200/');
    assert.equal(body.services.find((item: any) => item.name === 'Local memory generation endpoint').url, 'http://127.0.0.1:4001/v1');
    assert.equal(body.storage.find((item: any) => item.name === 'Canonical memory vault').path.endsWith('/effective-vault'), true);
    assert.equal(body.storage.find((item: any) => item.name === 'Memory index').path.endsWith('/indexes/effective.db'), true);
  } finally {
    delete process.env.MEMORY_DAEMON_URL;
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('trust snapshot follows fallback environment credential precedence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-fallback-'));
  const configured = config(root);
  configured.models.openrouter.api_key = '${MISSING_OPENROUTER_KEY}';
  configured.assistant.api_key = '';
  process.env.OPENROUTING_API_KEY = 'legacy-openrouter-secret';
  process.env.ASSISTANT_API_KEY = 'assistant-fallback-secret';
  const { app, root: fixtureRoot } = await fixture({ config: configured });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.deepEqual(response.json().secrets.openrouter, { configured: true, source: 'environment' });
    assert.deepEqual(response.json().secrets.assistant, { configured: true, source: 'environment' });
    assert.equal(response.body.includes('legacy-openrouter-secret'), false);
    assert.equal(response.body.includes('assistant-fallback-secret'), false);
  } finally {
    delete process.env.OPENROUTING_API_KEY;
    delete process.env.ASSISTANT_API_KEY;
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('trust snapshot namespaces Pi providers and fails soft when auth metadata is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-auth-'));
  const failingPi = {
    paths: { authFile: join(root, 'auth.json') },
    auth: { listCredentials: async () => { throw new Error('auth file contained sensitive detail'); } },
  };
  const { app, root: fixtureRoot } = await fixture({ pi: failingPi });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().secrets['pi-auth'], {
      configured: false, source: 'unknown', location: join(root, 'auth.json'),
    });
    assert.equal(response.body.includes('sensitive detail'), false);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const collidingPi = {
    paths: { authFile: join(root, 'auth.json') },
    auth: { listCredentials: async () => [{ providerId: 'openrouter', type: 'api_key' }] },
  };
  const collision = await fixture({ pi: collidingPi });
  try {
    const body = (await collision.app.inject({ method: 'GET', url: '/api/trust' })).json();
    assert.equal(body.secrets.openrouter.source, 'config-env-reference');
    assert.equal(body.secrets['pi:openrouter'].source, 'pi-auth-file');
  } finally {
    await collision.app.close();
    rmSync(collision.root, { recursive: true, force: true });
  }
});

test('trust snapshot reports Monday secret source, outbound destination, and mirror storage', async () => {
  delete process.env.MONDAY_TOKEN;
  process.env.MONDAY_TOKEN = 'monday-secret';
  const root = mkdtempSync(join(tmpdir(), 'nexus-trust-monday-'));
  const configured = config(root);
  configured.monday = { enabled: true, api_version: '2026-07', poll_minutes: 10 };
  const { app, root: fixtureRoot } = await fixture({ config: configured });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.secrets.monday, { configured: true, source: 'environment' });
    assert.deepEqual(body.outbound.find((item: any) => item.name === 'Monday.com'), {
      name: 'Monday.com',
      destination: 'https://api.monday.com/v2',
      sends: ['account identity', 'item queries'],
      enabled: true,
    });
    assert.equal(body.storage.some((item: any) => item.name === 'Monday item mirror' && item.role === 'rebuildable'), true);
    assert.equal(response.body.includes('monday-secret'), false);
  } finally {
    delete process.env.MONDAY_TOKEN;
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('trust snapshot reports Monday as absent and disabled when unconfigured', async () => {
  delete process.env.MONDAY_TOKEN;
  const { app, root } = await fixture(); // config() helper's monday block defaults to { enabled: false }
  try {
    const response = await app.inject({ method: 'GET', url: '/api/trust' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.secrets.monday, { configured: false, source: 'absent' });
    assert.equal(body.outbound.find((item: any) => item.name === 'Monday.com').enabled, false);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('clear proxy requires exact confirmation and proxies successful operations', async () => {
  const { app, root } = await fixture();
  try {
    const bad = await app.inject({ method: 'POST', url: '/api/trust/memory/clear-nexus', payload: { confirmation: 'wrong' } });
    assert.equal(bad.statusCode, 400);
    const rebuilt = await app.inject({ method: 'POST', url: '/api/trust/memory/rebuild' });
    assert.equal(rebuilt.statusCode, 200);
    assert.equal(rebuilt.json().reindexed, 1);
    const cleared = await app.inject({ method: 'POST', url: '/api/trust/memory/clear-nexus', payload: { confirmation: 'CLEAR NEXUS MEMORY' } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().deleted, 1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trust route maps daemon unavailability to 503 and preserves 409 conflicts', async () => {
  for (const [error, expected] of [[new TypeError('fetch failed'), 503], [new DaemonRequestError(409, 'maintenance busy'), 409]] as const) {
    const { app, root } = await fixture({ daemon: { rebuildIndex: async () => { throw error; }, clearNexusMemory: async () => { throw error; } } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/trust/memory/rebuild' });
      assert.equal(response.statusCode, expected);
      assert.equal(response.body.includes('fetch failed'), false);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
