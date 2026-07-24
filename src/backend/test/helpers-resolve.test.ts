import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NexusConfig } from '@nexus/shared';
import {
  liveHelpers,
  anyHelperLive,
  chooseSearchProvider,
  buildHelpersToolDeps,
} from '../helpers/resolve';

// A real dev shell may export these; a default config uses `${BRAVE_API_KEY}`
// etc., so resolveEnvVars would flip "disabled" cases live. These tests use
// literal keys instead, but clear the env too so nothing leaks in.
for (const v of ['BRAVE_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY', 'CONTEXT7_API_KEY']) {
  delete process.env[v];
}

const OFF = { enabled: false, api_key: '' };

/** Build just the slice of config these functions read. */
function cfg(over: {
  brave?: { enabled: boolean; api_key: string };
  exa?: { enabled: boolean; api_key: string };
  perplexity?: { enabled: boolean; api_key: string };
  context7?: { enabled: boolean; api_key: string };
  search_default?: 'brave' | 'exa';
} = {}): NexusConfig {
  return {
    helpers: {
      brave: over.brave ?? OFF,
      exa: over.exa ?? OFF,
      perplexity: over.perplexity ?? OFF,
      context7: over.context7 ?? OFF,
      search_default: over.search_default ?? 'exa',
    },
  } as unknown as NexusConfig;
}

const ON = (key: string) => ({ enabled: true, api_key: key });

test('nothing enabled ⇒ no deps and no live helpers', () => {
  assert.equal(buildHelpersToolDeps(cfg()), null);
  assert.equal(anyHelperLive(cfg()), false);
  assert.deepEqual(liveHelpers(cfg()), {
    brave: false,
    exa: false,
    perplexity: false,
    context7: false,
  });
});

test('enabled but empty key ⇒ not live', () => {
  assert.equal(buildHelpersToolDeps(cfg({ brave: { enabled: true, api_key: '' } })), null);
});

test('key present but disabled ⇒ not live', () => {
  assert.equal(buildHelpersToolDeps(cfg({ brave: { enabled: false, api_key: 'k' } })), null);
});

test('only Brave live ⇒ web_search present, answer/docs absent', () => {
  const deps = buildHelpersToolDeps(cfg({ brave: ON('bk') }));
  assert.ok(deps);
  assert.deepEqual(deps.searchProviders, ['brave']);
  assert.equal(typeof deps.search, 'function');
  assert.equal(deps.answer, undefined);
  assert.equal(deps.docs, undefined);
});

test('only Perplexity live ⇒ web_answer present, search/docs absent', () => {
  const deps = buildHelpersToolDeps(cfg({ perplexity: ON('pk') }));
  assert.ok(deps);
  assert.deepEqual(deps.searchProviders, []);
  assert.equal(deps.search, undefined);
  assert.equal(typeof deps.answer, 'function');
  assert.equal(deps.docs, undefined);
});

test('only Context7 live ⇒ docs_lookup present, search/answer absent', () => {
  const deps = buildHelpersToolDeps(cfg({ context7: ON('ck') }));
  assert.ok(deps);
  assert.equal(deps.search, undefined);
  assert.equal(deps.answer, undefined);
  assert.equal(typeof deps.docs, 'function');
});

test('both search providers ⇒ default honoured, explicit provider overrides', () => {
  const both = cfg({ brave: ON('bk'), exa: ON('ek'), search_default: 'exa' });
  assert.equal(chooseSearchProvider(both), 'exa'); // default
  assert.equal(chooseSearchProvider(both, 'brave'), 'brave'); // override respected
  assert.equal(chooseSearchProvider(both, 'exa'), 'exa');
  assert.deepEqual(buildHelpersToolDeps(both)!.searchProviders, ['brave', 'exa']);
});

test('a requested provider that is not live falls back to the default', () => {
  const exaOnly = cfg({ exa: ON('ek'), search_default: 'exa' });
  assert.equal(chooseSearchProvider(exaOnly, 'brave'), 'exa'); // brave not live → fall back
});

test('search_default that is not live falls back to the first live provider', () => {
  const braveOnly = cfg({ brave: ON('bk'), search_default: 'exa' });
  assert.equal(chooseSearchProvider(braveOnly), 'brave');
});

test('neither search provider live ⇒ chooseSearchProvider is null', () => {
  assert.equal(chooseSearchProvider(cfg({ perplexity: ON('pk') })), null);
});

test('${ENV} interpolation makes a provider live', () => {
  process.env.TEST_EXA_KEY = 'from-env';
  try {
    const deps = buildHelpersToolDeps(cfg({ exa: { enabled: true, api_key: '${TEST_EXA_KEY}' } }));
    assert.ok(deps);
    assert.deepEqual(deps.searchProviders, ['exa']);
  } finally {
    delete process.env.TEST_EXA_KEY;
  }
});
