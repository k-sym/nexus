/**
 * Live integration test for the browser tools, against a real Chromium-family
 * browser driving a real local HTTP server.
 *
 * Skipped when no browser is discovered (see ./gate.ts). The unit tests in
 * ../browser-tool.test.ts and ../browser-policy.test.ts drive a fake page and
 * prove the tool surface, the URL policy, and the pool bookkeeping; this proves
 * what only a real browser can — that CDP navigation, text/tree extraction, and
 * console/network capture actually work end to end. It is also the regression
 * guard for the AXValue bug that shipped: the mocked tests could not have caught
 * `readTree` returning empty.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { CdpConnection } from '../../browser/cdp';
import { BrowserPage } from '../../browser/page';
import { BrowserPool } from '../../browser/session-deps';
import { findBrowser } from '../../browser/discover';
import { liveSkip } from './gate';

const binary = findBrowser();
const skip = liveSkip('Chromium-family browser', binary !== null, 'no Chrome/Edge/Chromium/Brave found');

const PAGE = `<!doctype html><html><head><title>Nexus Live</title></head>
<body>
  <h1>Hello Nexus</h1>
  <main id="content"><p>Scoped region text.</p></main>
  <button type="button">Click me</button>
  <nav><a href="/other">Another page</a></nav>
  <script src="/missing.js"></script>
  <script>console.log('MARKER_LOG'); console.error('MARKER_ERROR');</script>
</body></html>`;

let server: Server;
let base = '';

before(async () => {
  if (skip !== false) return;
  server = createServer((req, res) => {
    if (req.url === '/missing.js') { res.writeHead(404); res.end('nope'); return; }
    if (req.url === '/gone') { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<h1>Not Found</h1>'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('navigate reports the title and HTTP status after the page loads', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    const result = await page.navigate(`${base}/`);
    assert.equal(result.title, 'Nexus Live');
    assert.equal(result.status, 200);
  } finally {
    await connection.close();
  }
});

test('readText returns rendered text and honours a selector', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);

    const text = await page.readText();
    assert.match(text, /Hello Nexus/);
    assert.match(text, /Click me/);
    // Rendered text, not markup.
    assert.equal(text.includes('<h1>'), false);
    assert.equal(text.includes('<script'), false);

    const scoped = await page.readText('#content');
    assert.match(scoped, /Scoped region text/);
    assert.equal(scoped.includes('Hello Nexus'), false, 'a selector scopes the read');

    // A selector matching nothing is an error, not an empty string.
    await assert.rejects(page.readText('#does-not-exist'));
  } finally {
    await connection.close();
  }
});

test('readTree returns the accessibility tree with roles and names', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);
    const tree = await page.readTree();

    // The regression that shipped: this came back empty because CDP's AXValue
    // is { type, value } and the walk read value.value.
    assert.ok(tree.length > 0, 'the tree is not empty');
    assert.match(tree, /heading "Hello Nexus"/);
    assert.match(tree, /button "Click me"/);
    assert.match(tree, /link "Another page"/);
    assert.ok(tree.length < PAGE.length * 2, 'the tree is a fraction of the raw HTML');
  } finally {
    await connection.close();
  }
});

test('console and network output is captured during load', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);

    const console_ = page.consoleEntries();
    assert.ok(console_.some((e) => e.text.includes('MARKER_LOG')), 'captured a console.log');
    assert.ok(console_.some((e) => e.text.includes('MARKER_ERROR')), 'captured a console.error');

    const net = page.networkEntries();
    assert.ok(net.some((e) => e.url === `${base}/` && e.status === 200), 'captured the document request');
    assert.ok(net.some((e) => e.url.endsWith('/missing.js') && e.status === 404), 'captured the 404 subresource');
  } finally {
    await connection.close();
  }
});

test('an HTTP error status is reported even when the page still renders', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    const result = await page.navigate(`${base}/gone`);
    assert.equal(result.status, 404);
  } finally {
    await connection.close();
  }
});

test('a refused connection errors promptly rather than hanging', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    const started = Date.now();
    await assert.rejects(page.navigate('http://127.0.0.1:1/'));
    assert.ok(Date.now() - started < 15_000, 'failed fast, not on the load timeout');
  } finally {
    await connection.close();
  }
});

test('the pool gives one browser per thread and closes them on drop', { skip }, async () => {
  const pool = new BrowserPool(binary!);
  try {
    const p1 = await pool.pageFor('thread-1');
    assert.equal(await pool.pageFor('thread-1'), p1, 'a thread reuses its browser');

    const p2 = await pool.pageFor('thread-2');
    assert.notEqual(p2, p1, 'a second thread gets its own');
    assert.equal(pool.size(), 2);

    // Racing calls in one thread share a launch rather than leaking a browser.
    const [a, b] = await Promise.all([pool.pageFor('thread-3'), pool.pageFor('thread-3')]);
    assert.equal(a, b);
    assert.equal(pool.size(), 3);

    await pool.close('thread-1');
    assert.equal(pool.size(), 2, 'closing one leaves the others');
  } finally {
    await pool.closeAll();
    assert.equal(pool.size(), 0, 'closeAll leaves nothing running');
  }
});
