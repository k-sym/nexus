import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerBrowserRoutes, type BrowserRouteOptions } from '../routes/browser';
import type { BrowserView } from '../browser/page';

function sampleView(overrides: Partial<BrowserView> = {}): BrowserView {
  return {
    image: { data: 'AAAABBBB', mimeType: 'image/jpeg' },
    url: 'http://localhost:5173/',
    title: 'Dev Server',
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    version: 3,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function buildApp(opts: BrowserRouteOptions): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(async (f) => { await registerBrowserRoutes(f, opts); });
  await app.ready();
  return app;
}

test('GET view reports unavailable without consulting the browser when the feature is off', async () => {
  let called = false;
  const app = await buildApp({ enabled: () => false, view: async () => { called = true; return null; } });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1' });
    assert.deepEqual(res.json(), { available: false, present: false });
    assert.equal(called, false, 'the page is not even peeked when the feature is off');
  } finally {
    await app.close();
  }
});

test('GET view without a thread is available but not present', async () => {
  const app = await buildApp({ enabled: () => true, view: async () => sampleView() });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/browser/view' });
    assert.deepEqual(res.json(), { available: true, present: false });
  } finally {
    await app.close();
  }
});

test('GET view returns the snapshot for a thread whose browser is open', async () => {
  const view = sampleView();
  const app = await buildApp({ enabled: () => true, view: async (id) => (id === 't1' ? view : null) });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1' });
    assert.deepEqual(res.json(), { available: true, present: true, view });

    // A thread with no browser open is present:false, not an error.
    const none = await app.inject({ method: 'GET', url: '/api/browser/view?thread=other' });
    assert.deepEqual(none.json(), { available: true, present: false });
  } finally {
    await app.close();
  }
});

test('GET view withholds the bytes when the client already holds the current version', async () => {
  const view = sampleView({ version: 7 });
  const app = await buildApp({ enabled: () => true, view: async () => view });
  try {
    // known matches ⇒ no image bytes, just the version.
    const same = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1&known=7' });
    assert.deepEqual(same.json(), { available: true, present: true, unchanged: true, version: 7 });

    // known is stale ⇒ the full frame is sent.
    const stale = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1&known=6' });
    assert.deepEqual(stale.json(), { available: true, present: true, view });

    // a non-numeric known is ignored, not treated as a match.
    const junk = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1&known=abc' });
    assert.deepEqual(junk.json(), { available: true, present: true, view });
  } finally {
    await app.close();
  }
});

test('GET view treats a capture failure as nothing-to-show rather than a 500', async () => {
  const app = await buildApp({ enabled: () => true, view: async () => { throw new Error('capture blew up'); } });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { available: true, present: false });
  } finally {
    await app.close();
  }
});

test('the route defaults to unavailable when built without browser support', async () => {
  const app = await buildApp({});
  try {
    const res = await app.inject({ method: 'GET', url: '/api/browser/view?thread=t1' });
    assert.deepEqual(res.json(), { available: false, present: false });
  } finally {
    await app.close();
  }
});
