import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerEngineRoutes } from '../routes/engines.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerPiRoutes } from '../routes/pi.js';
import { claudeEngineStatus, isPiAnthropicOAuthHidden } from '../engines/claude/status.js';
import { EngineRegistry } from '../engines/registry.js';
import { PiEngine } from '../engines/pi-engine.js';

const enabled = { enabled: true, auth: 'subscription' as const, oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}', executable_path: '' };

test('claudeEngineStatus reports token, login and api_key modes without leaking the token', () => {
  assert.deepEqual(claudeEngineStatus(enabled, { CLAUDE_CODE_OAUTH_TOKEN: 'secret' }), {
    id: 'claude-code', enabled: true, auth: 'subscription', tokenConfigured: true, authSource: 'token', executablePath: null, modelCount: 5,
  });
  assert.equal(claudeEngineStatus(enabled, {}).authSource, 'login');
  assert.equal(claudeEngineStatus({ ...enabled, auth: 'api_key' }, {}).authSource, 'api_key');
  assert.equal(claudeEngineStatus({ ...enabled, executable_path: '/opt/claude' }, {}).executablePath, '/opt/claude');
  assert.ok(!JSON.stringify(claudeEngineStatus(enabled, { CLAUDE_CODE_OAUTH_TOKEN: 'secret' })).includes('secret'));
});

test('isPiAnthropicOAuthHidden is true only for an enabled engine plus a stored OAuth credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-'));
  try {
    const authFile = join(dir, 'auth.json');
    writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'oauth', access: 'x', refresh: 'y', expires: 0 } }));
    assert.equal(isPiAnthropicOAuthHidden(enabled, authFile), true);
    assert.equal(isPiAnthropicOAuthHidden({ ...enabled, enabled: false }, authFile), false);
    writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'api_key', key: 'sk' } }));
    assert.equal(isPiAnthropicOAuthHidden(enabled, authFile), false);
    writeFileSync(authFile, '{}');
    assert.equal(isPiAnthropicOAuthHidden(enabled, authFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/engines returns the status and the hidden flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-'));
  const authFile = join(dir, 'auth.json');
  writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'oauth', access: 'x', refresh: 'y', expires: 0 } }));
  const app = Fastify({ logger: false });
  app.decorate('pi', { paths: { authFile } } as any);
  app.register(registerEngineRoutes, { config: () => enabled, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/engines' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.engines[0].authSource, 'token');
    assert.equal(body.piAnthropicOAuthHidden, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/auth/start-oauth refuses anthropic subscription login while the Claude engine is enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-auth-'));
  const authFile = join(dir, 'auth.json');
  const app = Fastify({ logger: false });
  app.decorate('pi', {
    auth: { listCredentials: async () => [] },
    paths: { authFile },
  } as any);
  app.decorate('oauthFlows', { start: () => ({ id: 'flow-1' }) } as any);
  app.register(registerAuthRoutes, { config: () => enabled });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/auth/start-oauth', payload: { provider: 'anthropic' } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { ok: false, reason: 'claude_engine_owns_anthropic' });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/models/active honours the engine registry hidden set', async () => {
  const models = [
    { provider: 'anthropic', id: 'x', name: 'X', input: ['text'] },
    { provider: 'anthropic', id: 'y', name: 'Y', input: ['text'] },
  ];
  const piRuntimeModels = {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
    getAvailable: () => models,
  };
  const piEngine = new PiEngine({ models: piRuntimeModels } as any, {
    isHidden: (m) => m.provider === 'anthropic' && m.id === 'x',
  });
  const app = Fastify({ logger: false });
  app.decorate('pi', { models: piRuntimeModels } as any);
  app.decorate('engines', new EngineRegistry([piEngine]));
  app.register(registerPiRoutes, {
    capabilityResolver: { peek: () => ({} as any), resolve: async () => ({} as any) },
  });
  try {
    const hidden = await app.inject({
      method: 'POST',
      url: '/api/models/active',
      payload: { provider: 'anthropic', model: 'x' },
    });
    assert.deepEqual(hidden.json(), { ok: false, reason: 'model_not_found' });

    const visible = await app.inject({
      method: 'POST',
      url: '/api/models/active',
      payload: { provider: 'anthropic', model: 'y' },
    });
    assert.equal(visible.json().ok, true);
  } finally {
    await app.close();
  }
});
