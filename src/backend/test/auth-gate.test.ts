import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerBackendAuth, tokenMatches } from '../auth-gate.js';

function makeApp(token: string) {
  const app = Fastify();
  registerBackendAuth(app, token);
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/thing', async () => ({ ok: true }));
  return app;
}

test('empty token leaves the backend open (dev-open)', async () => {
  const app = makeApp('');
  const res = await app.inject({ method: 'GET', url: '/api/thing' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('with a token: health is public, /api/* needs a matching bearer', async () => {
  const app = makeApp('s3cret-token');

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200, 'health stays public for probes');

  const missing = await app.inject({ method: 'GET', url: '/api/thing' });
  assert.equal(missing.statusCode, 401, 'no header is rejected');

  const wrong = await app.inject({
    method: 'GET',
    url: '/api/thing',
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrong.statusCode, 401, 'wrong token is rejected');

  const ok = await app.inject({
    method: 'GET',
    url: '/api/thing',
    headers: { authorization: 'Bearer s3cret-token' },
  });
  assert.equal(ok.statusCode, 200, 'matching token passes through');

  await app.close();
});

test('tokenMatches is exact and length-safe', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false);
});
