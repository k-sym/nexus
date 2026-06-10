import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthFlowManager } from '../pi/oauth-flows';

test('OAuthFlowManager records auth URL and completes successful login', async () => {
  const manager = new OAuthFlowManager({
    login: async (_provider, callbacks) => {
      callbacks.onAuth({ url: 'https://example.test/auth', instructions: 'Open this URL' });
      callbacks.onProgress?.('Waiting for login');
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
    login: async (_provider, callbacks) => {
      const code = await callbacks.onPrompt({ message: 'Paste code', placeholder: 'code' });
      callbacks.onProgress?.(`received:${code}`);
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
    login: async (_provider, callbacks) => {
      await new Promise((_resolve, reject) => {
        callbacks.signal?.addEventListener('abort', () => reject(new Error('Login cancelled')));
      });
    },
  });
  const flow = manager.start('openai-codex');
  manager.cancel(flow.id);
  await flow.done.catch(() => undefined);
  assert.equal(manager.status(flow.id)?.state, 'cancelled');
});
