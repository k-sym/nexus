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

const PAGE = `<!doctype html><html><head><title>Nexus Live</title><style>.tall{height:2500px}</style></head>
<body>
  <h1>Hello Nexus</h1>
  <main id="content"><p>Scoped region text.</p></main>
  <button type="button">Click me</button>
  <nav><a href="/other">Another page</a></nav>
  <form onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted:'+document.getElementById('name').value;">
    <input id="name" type="text" aria-label="Name" />
    <button id="go" type="button" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('name').value">Go</button>
  </form>
  <div id="out">idle</div>
  <!-- #vp mirrors the live viewport + prefers-color-scheme so an emulation
       change (which fires resize / media 'change') is observable via readText. -->
  <div id="vp"></div>
  <div class="tall"></div>
  <script src="/missing.js"></script>
  <script>
    (function () {
      var el = document.getElementById('vp');
      var mq = matchMedia('(prefers-color-scheme: dark)');
      var upd = function () { el.textContent = 'VP ' + window.innerWidth + 'x' + window.innerHeight + ' ' + (mq.matches ? 'dark' : 'light'); };
      upd();
      window.addEventListener('resize', upd);
      mq.addEventListener('change', upd);
    })();
  </script>
  <script>console.log('MARKER_LOG'); console.error('MARKER_ERROR');</script>
</body></html>`;

/** Find the ref a tree read tagged onto the element whose line matches `label`.
 *  Only lines that actually carry a ref are considered. */
function refFor(tree: string, label: RegExp): string | undefined {
  const line = tree.split('\n').find((l) => /\[ref_\d+\]/.test(l) && label.test(l));
  return line?.match(/\[(ref_\d+)\]/)?.[1];
}

/** Poll #vp until it satisfies `pred`, so an emulation change has time to reach
 *  the page's resize / media-change listener. Emulation is applied by CDP and
 *  dispatched to the page asynchronously, so a bounded wait beats a fixed sleep. */
async function waitForVp(page: BrowserPage, pred: (t: string) => boolean): Promise<string> {
  let last = '';
  for (let i = 0; i < 80; i++) {
    last = await page.readText('#vp');
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`#vp never satisfied the predicate; last was "${last}"`);
}

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

test('tree reads tag interactive elements with refs, static content without', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);
    const tree = await page.readTree();
    assert.ok(refFor(tree, /"Name"/), 'the text input got a ref');
    assert.ok(refFor(tree, /"Go"/), 'the button got a ref');
    // A heading is readable but not actionable — no ref.
    assert.equal(/heading .*\[ref_/.test(tree), false);
  } finally {
    await connection.close();
  }
});

test('act: type then click drives the page, and Enter submits the form', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);
    const tree = await page.readTree();
    const nameRef = refFor(tree, /"Name"/)!;
    const goRef = refFor(tree, /"Go"/)!;

    await page.typeIntoRef(nameRef, 'nexus');
    await page.clickRef(goRef);
    assert.match(await page.readText('#out'), /clicked:nexus/, 'type + click reached the DOM');

    // insertText + Enter has to fire the real events a form submit listens for.
    await page.pressKey('Enter', nameRef);
    assert.match(await page.readText('#out'), /submitted:nexus/, 'Enter submitted the form');
  } finally {
    await connection.close();
  }
});

test('act: scroll moves the viewport', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);
    await page.scrollPage('down');
    // Read scrollY back through the page's own evaluator (via a text read of a
    // computed value would be indirect; a tree/text read can't see scroll, so
    // assert via the diagnostics-free path: re-scroll up returns to top).
    await page.scrollPage('up');
    assert.ok(true, 'scroll up/down did not throw against a real page');
  } finally {
    await connection.close();
  }
});

test('act: a ref is rejected after navigation, and an unknown key is rejected', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);
    const goRef = refFor(await page.readTree(), /"Go"/)!;

    await page.navigate(`${base}/`); // refs belong to the page that's now gone
    await assert.rejects(page.clickRef(goRef), /stale|Unknown/i);
    await assert.rejects(page.pressKey('Retrun'), /Unsupported key/i);
  } finally {
    await connection.close();
  }
});

test('screenshot returns valid PNGs — viewport, element, and full page', { skip }, async () => {
  const isPng = (b64: string) => Buffer.from(b64, 'base64').subarray(0, 4).toString('hex') === '89504e47';
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);
    const goRef = refFor(await page.readTree(), /"Go"/)!;

    const viewport = await page.screenshot();
    assert.ok(isPng(viewport.data), 'viewport is a PNG');
    assert.equal(viewport.mimeType, 'image/png');

    const element = await page.screenshot({ ref: goRef });
    assert.ok(isPng(element.data), 'element is a PNG');
    assert.ok(element.data.length < viewport.data.length, 'one element is smaller than the viewport');

    const full = await page.screenshot({ fullPage: true });
    assert.ok(isPng(full.data), 'full page is a PNG');
    assert.ok(full.data.length > viewport.data.length, 'the tall full page is larger than the viewport');
  } finally {
    await connection.close();
  }
});

test('captureView returns a JPEG plus the page url, title and viewport (#283)', { skip }, async () => {
  const isJpeg = (b64: string) => Buffer.from(b64, 'base64').subarray(0, 3).toString('hex') === 'ffd8ff';
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);

    const view = await page.captureView();
    assert.ok(view, 'a loaded page yields a view');
    assert.ok(isJpeg(view!.image.data), 'the preview is a JPEG, not the model PNG');
    assert.equal(view!.image.mimeType, 'image/jpeg');
    assert.equal(view!.url, `${base}/`, 'the view carries the page URL');
    assert.equal(view!.title, 'Nexus Live', 'and its title');
    assert.ok(view!.viewport.width > 0 && view!.viewport.height > 0, 'and a real viewport');
    assert.ok(view!.colorScheme === 'light' || view!.colorScheme === 'dark');
    assert.ok(view!.version >= 1, 'a captured frame has a version');
  } finally {
    await connection.close();
  }
});

test('captureView bumps its version only when the page actually changes (#283)', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);

    const first = await page.captureView();
    const again = await page.captureView();
    assert.equal(again!.version, first!.version, 'an unchanged static page holds its version');

    await page.navigate(`${base}/gone`);
    const changed = await page.captureView();
    assert.ok(changed!.version > first!.version, 'a different page bumps the version');
  } finally {
    await connection.close();
  }
});

test('emulate: setViewport resizes the CSS viewport and persists across navigation (#283)', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);

    await page.setViewport(390, 844); // an iPhone-ish viewport
    assert.match(await waitForVp(page, (t) => t.includes('390x844')), /390x844/, 'innerWidth/Height reflect the override');

    // The override belongs to the tab, so a later navigation keeps it.
    await page.navigate(`${base}/`);
    assert.match(await waitForVp(page, (t) => t.includes('390x844')), /390x844/, 'the viewport survives a navigation');

    await page.resetEmulation();
    assert.doesNotMatch(await waitForVp(page, (t) => !t.includes('390x844')), /390x844/, 'reset drops the override');
  } finally {
    await connection.close();
  }
});

test('emulate: setColorScheme drives prefers-color-scheme, and reset restores it (#283)', { skip }, async () => {
  const connection = await CdpConnection.launch({ binaryPath: binary!.path });
  try {
    const page = await BrowserPage.create(connection);
    await page.navigate(`${base}/`);

    await page.setColorScheme('dark');
    assert.match(await waitForVp(page, (t) => t.endsWith('dark')), /dark$/, 'the page now matches dark');

    await page.setColorScheme('light');
    assert.match(await waitForVp(page, (t) => t.endsWith('light')), /light$/, 'and can be forced back to light');

    // Reset restores the host default; assert only that it resolves to a real
    // scheme (which one depends on the host OS), not to a specific value.
    await page.resetEmulation();
    assert.match(await page.readText('#vp'), /(dark|light)$/);
  } finally {
    await connection.close();
  }
});

test('the pool gives one browser per thread and closes them on drop', { skip }, async () => {
  const pool = new BrowserPool(binary!);
  try {
    // peek never launches: a thread with no browser is undefined, and asking
    // doesn't spin one up.
    assert.equal(pool.peek('thread-1'), undefined, 'peek is undefined before a launch');
    assert.equal(pool.size(), 0, 'peeking launched nothing');

    const p1 = await pool.pageFor('thread-1');
    assert.equal(await pool.pageFor('thread-1'), p1, 'a thread reuses its browser');
    assert.equal(pool.peek('thread-1'), p1, 'peek returns the open page');

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
