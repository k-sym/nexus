import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserExtension } from '../pi/browser-tool';
import { createBrowserSupport, MAX_CONCURRENT_BROWSERS } from '../browser/session-deps';
import { parseDevToolsUrl, launchFlags } from '../browser/cdp';
import type { BrowserPage, ConsoleEntry, NetworkEntry } from '../browser/page';
import type { NexusConfig } from '@nexus/shared';

/** A stand-in page recording what the tools asked it to do. */
function fakePage(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const page = {
    navigate: async (url: string) => {
      calls.push({ op: 'navigate', args: [url] });
      return { url, title: 'Test Page', status: 200 };
    },
    readText: async (selector?: string) => {
      calls.push({ op: 'readText', args: [selector] });
      return 'the page text';
    },
    readTree: async () => {
      calls.push({ op: 'readTree', args: [] });
      return 'document\n  heading "Hello"';
    },
    consoleEntries: (limit?: number): ConsoleEntry[] => {
      calls.push({ op: 'consoleEntries', args: [limit] });
      return [{ level: 'error', text: 'boom', url: 'http://localhost/app.js' }];
    },
    networkEntries: (limit?: number): NetworkEntry[] => {
      calls.push({ op: 'networkEntries', args: [limit] });
      return [
        { method: 'GET', url: 'http://localhost/', status: 200 },
        { method: 'GET', url: 'http://localhost/missing.js', failed: 'net::ERR_ABORTED' },
      ];
    },
    clickRef: async (ref: string) => { calls.push({ op: 'clickRef', args: [ref] }); return `Clicked ${ref}.`; },
    typeIntoRef: async (ref: string, text: string) => { calls.push({ op: 'typeIntoRef', args: [ref, text] }); return `Typed into ${ref}.`; },
    pressKey: async (key: string, ref?: string) => { calls.push({ op: 'pressKey', args: [key, ref] }); return `Pressed ${key}.`; },
    scrollPage: async (direction: string) => { calls.push({ op: 'scrollPage', args: [direction] }); return `Scrolled ${direction}.`; },
    screenshot: async (opts: { ref?: string; fullPage?: boolean }) => {
      calls.push({ op: 'screenshot', args: [opts] });
      return { data: 'iVBORw0KGgoAAAANS', mimeType: 'image/png' };
    },
    ...overrides,
  } as unknown as BrowserPage;
  return { page, calls };
}

async function registerTools(allowedHosts: string[] = [], pageOverrides = {}) {
  const { page, calls } = fakePage(pageOverrides);
  const tools = new Map<string, any>();
  await createBrowserExtension({
    getPage: async () => page,
    allowedHosts: () => allowedHosts,
  })({ registerTool(value: any) { tools.set(value.name, value); } } as never);
  return { tools, calls };
}

test('the extension registers the full navigate/read/diagnostics/act/screenshot surface', async () => {
  const { tools } = await registerTools();
  assert.deepEqual([...tools.keys()].sort(), [
    'browser_act', 'browser_diagnostics', 'browser_navigate', 'browser_read', 'browser_screenshot',
  ]);
});

test('navigate loads an allowed URL and reports where it landed', async () => {
  const { tools, calls } = await registerTools();
  const result = await tools.get('browser_navigate').execute('c', { url: 'http://localhost:5173/' });
  assert.deepEqual(calls[0], { op: 'navigate', args: ['http://localhost:5173/'] });
  assert.match(result.content[0].text, /Loaded http:\/\/localhost:5173\/ \(HTTP 200\)/);
  assert.match(result.content[0].text, /Title: Test Page/);
  assert.equal(result.details.httpStatus, 200);
});

test('a refused URL never reaches the browser', async () => {
  const { tools, calls } = await registerTools();
  await assert.rejects(
    tools.get('browser_navigate').execute('c', { url: 'file:///etc/passwd' }),
    /only load http and https/,
  );
  await assert.rejects(
    tools.get('browser_navigate').execute('c', { url: 'https://example.com/' }),
    /limited to this machine/,
  );
  assert.deepEqual(calls, [], 'nothing was navigated');
});

test('the host allowlist is read per call, so narrowing it takes effect at once', async () => {
  const { page } = fakePage();
  let hosts = ['example.com'];
  const tools = new Map<string, any>();
  await createBrowserExtension({ getPage: async () => page, allowedHosts: () => hosts })(
    { registerTool(v: any) { tools.set(v.name, v); } } as never,
  );

  await tools.get('browser_navigate').execute('c', { url: 'https://example.com/' });
  hosts = [];
  await assert.rejects(
    tools.get('browser_navigate').execute('c', { url: 'https://example.com/' }),
    /limited to this machine/,
  );
});

test('read defaults to text and honours a selector or tree mode', async () => {
  const { tools, calls } = await registerTools();
  const read = tools.get('browser_read');

  const text = await read.execute('c', {});
  assert.equal(text.content[0].text, 'the page text');
  assert.equal(text.details.mode, 'text');
  assert.deepEqual(calls[0], { op: 'readText', args: [undefined] });

  await read.execute('c', { selector: 'main' });
  assert.deepEqual(calls[1], { op: 'readText', args: ['main'] });

  const tree = await read.execute('c', { mode: 'tree' });
  assert.equal(tree.details.mode, 'tree');
  assert.deepEqual(calls[2], { op: 'readTree', args: [] });
});

test('an empty page reads as a statement, not a blank result', async () => {
  const { tools } = await registerTools([], { readText: async () => '' });
  const result = await tools.get('browser_read').execute('c', {});
  assert.equal(result.content[0].text, '(the page is empty)');
});

test('diagnostics render console and network entries legibly', async () => {
  const { tools } = await registerTools();
  const diagnostics = tools.get('browser_diagnostics');

  const console_ = await diagnostics.execute('c', { source: 'console' });
  assert.match(console_.content[0].text, /\[error\] boom \(http:\/\/localhost\/app\.js\)/);
  assert.equal(console_.details.count, 1);

  const network = await diagnostics.execute('c', { source: 'network' });
  assert.match(network.content[0].text, /GET http:\/\/localhost\/ — 200/);
  // A failed request is the interesting one; it must not render as a bare "?".
  assert.match(network.content[0].text, /FAILED: net::ERR_ABORTED/);
});

test('empty diagnostics say so rather than returning nothing', async () => {
  const { tools } = await registerTools([], {
    consoleEntries: () => [],
    networkEntries: () => [],
  });
  const diagnostics = tools.get('browser_diagnostics');
  assert.match((await diagnostics.execute('c', { source: 'console' })).content[0].text, /logged nothing/);
  assert.match((await diagnostics.execute('c', { source: 'network' })).content[0].text, /No network requests/);
});

// ── act ───────────────────────────────────────────────────────────────────────

test('act routes each action to the page and reports it', async () => {
  const { tools, calls } = await registerTools();
  const act = tools.get('browser_act');

  assert.match((await act.execute('c', { action: 'click', ref: 'ref_3' })).content[0].text, /Clicked ref_3/);
  assert.deepEqual(calls.at(-1), { op: 'clickRef', args: ['ref_3'] });

  await act.execute('c', { action: 'type', ref: 'ref_1', text: 'hello' });
  assert.deepEqual(calls.at(-1), { op: 'typeIntoRef', args: ['ref_1', 'hello'] });

  await act.execute('c', { action: 'press', key: 'Enter', ref: 'ref_1' });
  assert.deepEqual(calls.at(-1), { op: 'pressKey', args: ['Enter', 'ref_1'] });

  await act.execute('c', { action: 'scroll' });
  assert.deepEqual(calls.at(-1), { op: 'scrollPage', args: ['down'] }, 'scroll defaults to down');

  await act.execute('c', { action: 'scroll', direction: 'up' });
  assert.deepEqual(calls.at(-1), { op: 'scrollPage', args: ['up'] });
});

test('act rejects missing arguments before touching the page', async () => {
  const { tools, calls } = await registerTools();
  const act = tools.get('browser_act');

  await assert.rejects(act.execute('c', { action: 'click' }), /needs a ref/);
  await assert.rejects(act.execute('c', { action: 'type', ref: 'ref_1' }), /needs text/);
  await assert.rejects(act.execute('c', { action: 'type', text: 'x' }), /needs a ref/);
  await assert.rejects(act.execute('c', { action: 'press' }), /needs a key/);
  // None of those reached the page.
  assert.deepEqual(calls, []);
});

// ── screenshot ──────────────────────────────────────────────────────────────

test('screenshot returns image content plus a text caption', async () => {
  const { tools, calls } = await registerTools();
  const result = await tools.get('browser_screenshot').execute('c', {});

  const image = result.content.find((c: { type: string }) => c.type === 'image');
  assert.ok(image, 'returns image content');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 0);
  assert.match(result.content.find((c: { type: string }) => c.type === 'text').text, /viewport/);
  assert.deepEqual(calls.at(-1), { op: 'screenshot', args: [{ ref: undefined, fullPage: undefined }] });
});

test('screenshot passes ref and full_page through, and labels the scope', async () => {
  const { tools, calls } = await registerTools();
  const screenshot = tools.get('browser_screenshot');

  const el = await screenshot.execute('c', { ref: 'ref_2' });
  assert.deepEqual(calls.at(-1), { op: 'screenshot', args: [{ ref: 'ref_2', fullPage: undefined }] });
  assert.match(el.details.scope, /element ref_2/);

  const full = await screenshot.execute('c', { full_page: true });
  assert.deepEqual(calls.at(-1), { op: 'screenshot', args: [{ ref: undefined, fullPage: true }] });
  assert.match(full.details.scope, /full page/);
});

// ── launch plumbing ───────────────────────────────────────────────────────────

test('the DevTools endpoint is parsed out of startup chatter', () => {
  assert.equal(
    parseDevToolsUrl('\nDevTools listening on ws://127.0.0.1:51234/devtools/browser/abc-123\n'),
    'ws://127.0.0.1:51234/devtools/browser/abc-123',
  );
  assert.equal(parseDevToolsUrl('[0101/000000.000:WARNING:something] noise'), null);
  assert.equal(parseDevToolsUrl(''), null);
});

test('launch flags use an ephemeral profile and keep the sandbox', () => {
  const flags = launchFlags('/tmp/nexus-browser-xyz');
  assert.ok(flags.includes('--user-data-dir=/tmp/nexus-browser-xyz'), 'never the user profile');
  assert.ok(flags.includes('--headless=new'));
  assert.ok(flags.some((f) => f.startsWith('--remote-debugging-port=')));
  // The sandbox is what stands between a hostile page and the host. Disabling
  // it is a common copy-paste fix that must not creep in here.
  assert.ok(!flags.includes('--no-sandbox'));
  assert.ok(!flags.includes('--disable-web-security'));
});

// ── session wiring ────────────────────────────────────────────────────────────

const configWith = (over: Record<string, unknown> = {}) => () =>
  ({ browser: { enabled: true, allow_hosts: [], ...over } }) as unknown as NexusConfig;

const fakeBinary = () => ({ path: '/fake/chrome', name: 'Fake' });

test('there is no browser support at all when the machine has no browser', () => {
  assert.equal(createBrowserSupport({ getConfig: configWith(), findBrowserBinary: () => null }), null);
});

test('the tools are omitted when the feature is off', () => {
  const support = createBrowserSupport({
    getConfig: () => ({ browser: { enabled: false, allow_hosts: [] } }) as unknown as NexusConfig,
    findBrowserBinary: fakeBinary,
  });
  assert.ok(support);
  assert.equal(support!.browserTools('t', '/repo'), null);
});

test('the tools are offered when enabled, carrying the configured hosts', () => {
  const support = createBrowserSupport({
    getConfig: configWith({ allow_hosts: ['staging.internal'] }),
    findBrowserBinary: fakeBinary,
  })!;
  const deps = support.browserTools('t', '/repo');
  assert.ok(deps);
  assert.deepEqual(deps!.allowedHosts(), ['staging.internal']);
});

test('a config that throws costs the tools, not the session', () => {
  const support = createBrowserSupport({
    getConfig: () => { throw new Error('bad yaml'); },
    findBrowserBinary: fakeBinary,
  })!;
  assert.equal(support.browserTools('t', '/repo'), null);
});

test('closing a thread that never opened a browser is a no-op', async () => {
  const support = createBrowserSupport({ getConfig: configWith(), findBrowserBinary: fakeBinary })!;
  support.closeBrowser('never-used');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(support.pool.size(), 0);
});

test('the concurrent-browser cap is a real number, not unbounded', () => {
  // Each browser is a real Chromium; without a cap a runaway takes the machine
  // down with it.
  assert.ok(MAX_CONCURRENT_BROWSERS > 0 && MAX_CONCURRENT_BROWSERS <= 8);
});
