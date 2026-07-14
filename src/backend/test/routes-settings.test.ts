import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerSettingsRoutes } from '../routes/settings';
import { registerPiRoutes } from '../routes/pi';
import { loadConfig, saveConfig } from '../config';
import { __primeTokenCache } from '../github/token';
import { PiRuntime } from '../pi/runtime';
import { ModelCurationStore } from '../pi/model-curation';

// A live GITHUB_TOKEN in the developer's shell (or .env) would flip the
// "token not detected" assertion below. Mirror the Jira tests' handling of
// JIRA_TOKEN and clear it so the precondition holds regardless of environment.
delete process.env.GITHUB_TOKEN;

function makeApp() {
  const app = Fastify({ logger: false });
  app.register(registerSettingsRoutes);
  return app;
}

test('GET /api/settings reports github_token_detected without exposing the token', async () => {
  const original = loadConfig();
  const app = makeApp();
  try {
    delete process.env.GITHUB_TOKEN;
    // Prime the resolver's gh-fallback cache to null so it can't shell out to a
    // real authenticated gh on this machine and flip the "not detected" check.
    __primeTokenCache(null);
    const absent = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(absent.statusCode, 200);
    const absentJson = absent.json();
    assert.equal(absentJson.github_token_detected, false);
    // The raw token value is never present in any field.
    assert.equal(JSON.stringify(absentJson).includes('GITHUB_TOKEN'), false);

    process.env.GITHUB_TOKEN = 'ghp_secret_value';
    const present = await app.inject({ method: 'GET', url: '/api/settings' });
    const presentJson = present.json();
    assert.equal(presentJson.github_token_detected, true);
    // Derived boolean only — the secret value itself is not echoed.
    assert.equal(JSON.stringify(presentJson).includes('ghp_secret_value'), false);
  } finally {
    delete process.env.GITHUB_TOKEN;
    saveConfig(original);
    await app.close();
  }
});

test('PUT /api/settings round-trips github.enabled and never persists the derived flag', async () => {
  const original = loadConfig();
  const app = makeApp();
  try {
    delete process.env.GITHUB_TOKEN;
    __primeTokenCache(null);
    // Echo the derived flag back (as the UI would) to confirm it is stripped.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...original, github: { enabled: false }, github_token_detected: true },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().github.enabled, false);

    // Persisted config carries the toggle but not the derived flag.
    const persisted = loadConfig() as any;
    assert.equal(persisted.github.enabled, false);
    assert.equal('github_token_detected' in persisted, false);

    // GET reflects the persisted toggle.
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(get.json().github.enabled, false);

    // Flip it back on and confirm the round-trip both ways.
    const reEnable = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...original, github: { enabled: true } },
    });
    assert.equal(reEnable.json().github.enabled, true);
  } finally {
    saveConfig(original);
    await app.close();
  }
});

test('settings masks and preserves assistant api key', async () => {
  const original = loadConfig();
  const app = makeApp();
  try {
    delete process.env.GITHUB_TOKEN;
    __primeTokenCache(null);
    const configWithAssistant = {
      ...original,
      assistant: {
        url: 'https://assistant.example.test/v1',
        api_key: 'assistant-secret',
      },
    };
    saveConfig(configWithAssistant);

    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().assistant.url, 'https://assistant.example.test/v1');
    assert.equal(get.json().assistant.api_key, '••••••••');
    assert.equal(JSON.stringify(get.json()).includes('assistant-secret'), false);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        ...get.json(),
        assistant: {
          url: 'https://assistant.example.test/updated',
          api_key: '••••••••',
        },
      },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().assistant.url, 'https://assistant.example.test/updated');
    assert.equal(put.json().assistant.api_key, '••••••••');

    const persisted = loadConfig();
    assert.equal(persisted.assistant.url, 'https://assistant.example.test/updated');
    assert.equal(persisted.assistant.api_key, 'assistant-secret');
  } finally {
    saveConfig(original);
    await app.close();
  }
});

test('settings masks and preserves the backend token, round-trips server.url', async () => {
  const original = loadConfig();
  const app = makeApp();
  try {
    delete process.env.GITHUB_TOKEN;
    __primeTokenCache(null);
    const configWithToken = {
      ...original,
      server: { ...original.server, url: 'https://baker-pro.example.ts.net:8444', token: 'backend-secret' },
    };
    saveConfig(configWithToken);

    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().server.url, 'https://baker-pro.example.ts.net:8444');
    assert.equal(get.json().server.token, '••••••••');
    assert.equal(JSON.stringify(get.json()).includes('backend-secret'), false);

    // Echo the masked token back (as the UI would) while changing the URL — the
    // stored secret must survive rather than being overwritten by the mask.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...get.json(), server: { ...get.json().server, url: 'https://baker-pro.example.ts.net:9000' } },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().server.url, 'https://baker-pro.example.ts.net:9000');
    assert.equal(put.json().server.token, '••••••••');

    const persisted = loadConfig();
    assert.equal(persisted.server.url, 'https://baker-pro.example.ts.net:9000');
    assert.equal(persisted.server.token, 'backend-secret');
  } finally {
    saveConfig(original);
    await app.close();
  }
});

test('POST /api/settings/local-model/test verifies the configured chat model responds', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, 'qwen2.5-coder:7b');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const app = makeApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/local-model/test',
      payload: {
        base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: 'local',
        chat_model: 'qwen2.5-coder:7b',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'Local model responded.',
      models: ['qwen2.5-coder:7b'],
      modelFound: true,
    });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('PUT /api/settings enables configured local chat model in an existing curated list', async () => {
  const original = loadConfig();
  const originalOmlxApiKey = process.env.OMLX_API_KEY;
  const dir = mkdtempSync(join(tmpdir(), 'nexus-settings-models-'));
  const localModelId = '/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf';
  const localModelKey = `local/${localModelId}`;
  const app = Fastify({ logger: false });
  const pi = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
    modelsFile: join(dir, 'models.json'),
  });
  const modelCuration = new ModelCurationStore(join(dir, 'model-curation.json'));
  modelCuration.save([]);
  app.decorate('pi', pi);
  app.decorate('modelCuration', modelCuration);
  app.register(registerSettingsRoutes);
  app.register(registerPiRoutes);
  try {
    delete process.env.OMLX_API_KEY;
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        ...original,
        models: {
          ...original.models,
          local: {
            ...original.models.local,
            base_url: 'http://127.0.0.1:8081/v1',
            api_key: '${OMLX_API_KEY}',
            display_name: 'Local Model',
            chat_model: localModelId,
          },
        },
      },
    });
    assert.equal(put.statusCode, 200);

    const models = await app.inject({ method: 'GET', url: '/api/models' });
    assert.deepEqual(models.json().enabledModelKeys, [localModelKey]);
    assert.deepEqual(
      models.json().models.map((model: any) => `${model.provider}/${model.id}`),
      [localModelKey],
    );
    assert.deepEqual(models.json().models.map((model: any) => model.name), ['Local Model']);
  } finally {
    if (originalOmlxApiKey === undefined) {
      delete process.env.OMLX_API_KEY;
    } else {
      process.env.OMLX_API_KEY = originalOmlxApiKey;
    }
    saveConfig(original);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /api/settings marks configured local chat model as image-capable when enabled', async () => {
  const original = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), 'nexus-settings-models-'));
  const localModelId = 'qwen2.5-vl-7b-instruct';
  const localModelKey = `local/${localModelId}`;
  const app = Fastify({ logger: false });
  const pi = new PiRuntime({
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
    modelsFile: join(dir, 'models.json'),
  });
  const modelCuration = new ModelCurationStore(join(dir, 'model-curation.json'));
  modelCuration.save([]);
  app.decorate('pi', pi);
  app.decorate('modelCuration', modelCuration);
  app.register(registerSettingsRoutes);
  app.register(registerPiRoutes);
  try {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        ...original,
        models: {
          ...original.models,
          local: {
            ...original.models.local,
            base_url: 'http://127.0.0.1:8081/v1',
            api_key: 'local',
            display_name: 'Local Vision Model',
            chat_model: localModelId,
            supports_images: true,
          },
        },
      },
    });
    assert.equal(put.statusCode, 200);

    const models = await app.inject({ method: 'GET', url: '/api/models' });
    assert.deepEqual(models.json().enabledModelKeys, [localModelKey]);
    assert.deepEqual(models.json().models[0].input, ['text', 'image']);
  } finally {
    saveConfig(original);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
