import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, providerError, HelperHttpError, type HttpResult } from '../helpers/client';

test('callProvider parses JSON and reports ok/status', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ hello: 'world' }), { status: 200 });
  const res = await callProvider('https://x', { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { hello: 'world' });
});

test('callProvider surfaces a non-2xx as ok:false without throwing', async () => {
  const fetchImpl: typeof fetch = async () => new Response('nope', { status: 401 });
  const res = await callProvider('https://x', { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.json, undefined); // non-JSON body → undefined, not a throw
  assert.equal(res.text, 'nope');
});

test('callProvider serialises a JSON body and sets method + headers', async () => {
  let seen: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response('{}', { status: 200 });
  };
  await callProvider('https://x', { fetchImpl, body: { a: 1 }, headers: { 'x-api-key': 'k' } });
  const headers = seen!.headers as Record<string, string>;
  assert.equal(seen!.method, 'POST'); // body present ⇒ POST by default
  assert.equal(seen!.body, JSON.stringify({ a: 1 }));
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Accept'], 'application/json');
  assert.equal(headers['x-api-key'], 'k');
});

test('callProvider maps a timeout to a HelperHttpError', async () => {
  // A fetch that never resolves until the request is aborted by the timeout.
  const hanging: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  await assert.rejects(
    callProvider('https://x', { fetchImpl: hanging, timeoutMs: 10 }),
    (e: unknown) => e instanceof HelperHttpError && /timed out/.test((e as Error).message),
  );
});

test('callProvider maps a network failure to a HelperHttpError', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    callProvider('https://x', { fetchImpl }),
    (e: unknown) => e instanceof HelperHttpError && /unreachable/.test((e as Error).message),
  );
});

test('providerError hints at the key on 401/403 and never echoes the body', () => {
  const res: HttpResult = { status: 401, ok: false, json: undefined, text: 'do-not-leak' };
  const err = providerError('Brave', res);
  assert.match(err.message, /Brave/);
  assert.match(err.message, /check the API key/);
  assert.doesNotMatch(err.message, /do-not-leak/);
});
