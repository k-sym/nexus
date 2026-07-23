import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, isLoopbackHost } from '../browser/policy';
import { browserCandidates, findBrowser } from '../browser/discover';
import { boundTailText } from '../text/bound';

const allowed = (url: string, hosts: string[] = []) => checkUrl(url, hosts).allowed;
const reasonFor = (url: string, hosts: string[] = []) => {
  const verdict = checkUrl(url, hosts);
  return verdict.allowed ? '' : verdict.reason;
};

test('loopback is allowed without any configuration', () => {
  for (const url of [
    'http://localhost:5173/',
    'http://127.0.0.1:4173/api/health',
    'http://[::1]:3000/',
    'https://localhost:8443/',
    'http://127.0.0.5:9000/',
    'http://app.localhost:3000/',
  ]) {
    assert.equal(allowed(url), true, url);
  }
});

test('non-loopback hosts are refused until listed', () => {
  assert.equal(allowed('https://example.com/'), false);
  assert.match(reasonFor('https://example.com/'), /limited to this machine/);
  assert.equal(allowed('https://example.com/', ['example.com']), true);
  // Exact match only, unless the pattern is dotted.
  assert.equal(allowed('https://api.example.com/', ['example.com']), false);
  assert.equal(allowed('https://api.example.com/', ['.example.com']), true);
  assert.equal(allowed('https://example.com/', ['.example.com']), true, 'a dotted pattern covers the apex too');
  assert.equal(allowed('https://anything.dev/', ['*']), true);
});

test('file: URLs are refused, and no host allowlist can re-enable them', () => {
  // The critical one: file:// would turn the browser into an unrestricted
  // filesystem reader, straight past every containment rule elsewhere.
  assert.equal(allowed('file:///etc/passwd'), false);
  assert.match(reasonFor('file:///etc/passwd'), /only load http and https/);
  assert.equal(allowed('file:///etc/passwd', ['*']), false, 'a wildcard host must not unlock a scheme');
  assert.equal(allowed('file://localhost/etc/passwd', ['*']), false);
});

test('other dangerous schemes are refused', () => {
  for (const url of [
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'javascript:alert(1)',
    'data:text/html,<script>fetch("http://evil")</script>',
    'view-source:http://localhost/',
    'ftp://localhost/etc',
    'about:blank',
  ]) {
    assert.equal(allowed(url, ['*']), false, url);
  }
});

test('a scheme allowlist means a novel scheme defaults to refused', () => {
  // A denylist would have to be updated for each new scheme; this must not.
  assert.equal(allowed('web+custom://localhost/thing', ['*']), false);
  assert.equal(allowed('intent://scan/#Intent;scheme=zxing;end', ['*']), false);
});

test('a relative or malformed URL is refused with a useful message', () => {
  assert.equal(allowed('/dashboard'), false);
  assert.match(reasonFor('/dashboard'), /Include the scheme/);
  assert.equal(allowed(''), false);
  assert.equal(allowed('   '), false);
  assert.equal(allowed('http://'), false);
});

test('the host check reads the parsed host, not the raw string', () => {
  // Credentials in the authority are the classic way to make a URL *look* like
  // it points somewhere safe. The host here is evil.com, and it must be judged
  // as such.
  assert.equal(allowed('http://localhost@evil.com/'), false);
  assert.equal(allowed('http://evil.com#localhost'), false);
  assert.equal(allowed('http://evil.com/?next=localhost'), false);
  // ...and the reverse: a real loopback URL with a query mentioning a host.
  assert.equal(allowed('http://localhost:3000/?redirect=https://evil.com'), true);
});

test('isLoopbackHost covers the whole 127/8 range but not lookalikes', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.13.99.4'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('notlocalhost'), false);
  assert.equal(isLoopbackHost('localhost.evil.com'), false);
  assert.equal(isLoopbackHost('1270.0.1'), false);
});

// ── discovery ─────────────────────────────────────────────────────────────────

test('an explicit browser path wins, and a bad one is not silently ignored', () => {
  const found = findBrowser({ NEXUS_BROWSER_PATH: '/opt/my-chrome' }, 'linux', (p) => p === '/opt/my-chrome');
  assert.equal(found?.path, '/opt/my-chrome');

  // Falling back after an explicit setting would mean debugging the wrong binary.
  assert.equal(findBrowser({ NEXUS_BROWSER_PATH: '/nope' }, 'linux', () => false), null);
  assert.equal(
    findBrowser({ NEXUS_BROWSER_PATH: '/nope' }, 'darwin', (p) => p !== '/nope'),
    null,
    'an unusable override does not fall through to a discovered browser',
  );
});

test('discovery finds a browser per platform, or reports none', () => {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(findBrowser({}, 'darwin', (p) => p === macChrome)?.name, 'Google Chrome');
  assert.equal(findBrowser({}, 'linux', (p) => p === '/usr/bin/chromium')?.name, 'Chromium');
  assert.equal(findBrowser({}, 'darwin', () => false), null, 'no browser installed');

  // Every platform offers candidates; a typo'd platform falls back to the
  // Linux list rather than returning nothing at all.
  assert.ok(browserCandidates('darwin').length > 0);
  assert.ok(browserCandidates('win32').length > 0);
  assert.ok(browserCandidates('freebsd').length > 0);
});

// ── shared bounding ───────────────────────────────────────────────────────────

test('bounded text keeps the tail and never splits a character', () => {
  assert.equal(boundTailText('short', 100), 'short');

  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const bounded = boundTailText(long, 200, '[cut]');
  assert.match(bounded, /^\[cut\]/);
  assert.match(bounded, /line 299$/);

  // Page content is arbitrary text; a byte-wise cut through a multi-byte
  // character would render as U+FFFD.
  assert.ok(!boundTailText('日本語'.repeat(200), 64).includes('�'));
  assert.ok(!boundTailText('🎉'.repeat(200), 64).includes('�'));
});
