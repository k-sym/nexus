import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NexusConfig } from '@nexus/shared';
import { resolveToolPolicy } from '../pi/tool-policy-config';
import { evaluateCondition, TOOL_CONDITIONS } from '../pi/tool-policy-conditions';

const cfg = (tool_policy: unknown): NexusConfig => ({ tool_policy } as unknown as NexusConfig);

test('no tool_policy block resolves to empty (built-in defaults apply)', () => {
  assert.deepEqual(resolveToolPolicy({} as NexusConfig, '/repo'), { categories: {}, rules: [] });
});

test('global categories and rules pass through', () => {
  const resolved = resolveToolPolicy(
    cfg({ categories: { services: 'deny' }, rules: [{ tool: 'bash', decision: 'confirm' }] }),
    '/repo',
  );
  assert.deepEqual(resolved.categories, { services: 'deny' });
  assert.deepEqual(resolved.rules, [{ tool: 'bash', decision: 'confirm' }]);
});

test('a per-project entry overrides global categories and takes rule precedence', () => {
  const resolved = resolveToolPolicy(
    cfg({
      categories: { services: 'confirm', network: 'allow' },
      rules: [{ tool: 'browser_navigate', decision: 'confirm' }],
      projects: {
        '/repo/app': {
          categories: { services: 'deny' },
          rules: [{ tool: 'browser_navigate', when: 'loopback_host', decision: 'allow' }],
        },
      },
    }),
    '/repo/app',
  );

  // Project category wins; global one it doesn't touch is kept.
  assert.deepEqual(resolved.categories, { services: 'deny', network: 'allow' });
  // Project rule comes first (more specific → first-match wins), then global.
  assert.deepEqual(resolved.rules, [
    { tool: 'browser_navigate', when: 'loopback_host', decision: 'allow' },
    { tool: 'browser_navigate', decision: 'confirm' },
  ]);
});

test('a different repo gets only the global policy', () => {
  const resolved = resolveToolPolicy(
    cfg({ categories: { services: 'confirm' }, projects: { '/repo/app': { categories: { services: 'deny' } } } }),
    '/repo/other',
  );
  assert.deepEqual(resolved.categories, { services: 'confirm' }, 'the /repo/app override does not leak');
});

test('project paths match after normalization (trailing slash, ~ expansion)', () => {
  const resolved = resolveToolPolicy(
    cfg({ projects: { '/repo/app/': { categories: { exec: 'deny' } } } }),
    '/repo/app',
  );
  assert.deepEqual(resolved.categories, { exec: 'deny' }, 'trailing slash in the key still matches');
});

test('malformed rules are dropped during resolution', () => {
  const resolved = resolveToolPolicy(
    cfg({ rules: [{ tool: 'bash', decision: 'confirm' }, { decision: 'allow' }, null, 'nope'] }),
    '/repo',
  );
  assert.deepEqual(resolved.rules, [{ tool: 'bash', decision: 'confirm' }]);
});

// ── conditions ────────────────────────────────────────────────────────────────

test('remote_host / loopback_host classify a browser URL from the input', () => {
  const remote = { toolName: 'browser_navigate', input: { url: 'https://example.com/' } };
  const local = { toolName: 'browser_navigate', input: { url: 'http://127.0.0.1:3000/' } };

  assert.equal(TOOL_CONDITIONS.remote_host(remote), true);
  assert.equal(TOOL_CONDITIONS.remote_host(local), false);
  assert.equal(TOOL_CONDITIONS.loopback_host(local), true);
  assert.equal(TOOL_CONDITIONS.loopback_host(remote), false);
});

test('conditions are false for input with no or bad URL, never throwing', () => {
  for (const input of [{}, { url: 42 }, { url: 'not a url' }, null]) {
    assert.equal(TOOL_CONDITIONS.remote_host({ toolName: 'x', input }), false);
    assert.equal(TOOL_CONDITIONS.loopback_host({ toolName: 'x', input }), false);
  }
});

test('evaluateCondition returns undefined for an unknown condition', () => {
  assert.equal(evaluateCondition('remote_host', { toolName: 'x', input: { url: 'https://a.com/' } }), true);
  assert.equal(evaluateCondition('no_such_condition', { toolName: 'x', input: {} }), undefined);
});
