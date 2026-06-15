import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSettingsRoutes } from '../routes/settings';
import { loadConfig, saveConfig } from '../config';

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
