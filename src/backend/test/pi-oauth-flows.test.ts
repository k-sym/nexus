import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthFlowManager } from '../pi/oauth-flows';

test('OAuthFlowManager records auth URL and completes successful login', async () => {
  const manager = new OAuthFlowManager({
    login: async (_provider, _type, interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://example.test/auth', instructions: 'Open this URL' });
      interaction.notify({ type: 'progress', message: 'Waiting for login' });
      return { type: 'oauth', access: 'test', refresh: 'test', expires: Date.now() + 60_000 };
    },
  });
  const flow = manager.start('anthropic');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.status(flow.id);
  assert.equal(status?.state, 'complete');
  assert.equal(status?.authUrl, 'https://example.test/auth');
  assert.deepEqual(status?.messages, ['Waiting for login']);
});

test('OAuthFlowManager waits for manual prompt response', async () => {
  const manager = new OAuthFlowManager({
    login: async (_provider, _type, interaction) => {
      const code = await interaction.prompt({ type: 'text', message: 'Paste code', placeholder: 'code' });
      interaction.notify({ type: 'progress', message: `received:${code}` });
      return { type: 'oauth', access: 'test', refresh: 'test', expires: Date.now() + 60_000 };
    },
  });
  const flow = manager.start('anthropic');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.status(flow.id)?.state, 'needs_input');
  manager.respond(flow.id, 'abc123');
  await flow.done;
  assert.equal(manager.status(flow.id)?.state, 'complete');
  assert.deepEqual(manager.status(flow.id)?.messages, ['received:abc123']);
});

test('OAuthFlowManager cancels an active flow', async () => {
  const manager = new OAuthFlowManager({
    login: async (_provider, _type, interaction) => {
      await new Promise((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => reject(new Error('Login cancelled')));
      });
      return { type: 'oauth', access: 'test', refresh: 'test', expires: Date.now() + 60_000 };
    },
  });
  const flow = manager.start('openai-codex');
  manager.cancel(flow.id);
  await flow.done.catch(() => undefined);
  assert.equal(manager.status(flow.id)?.state, 'cancelled');
});
