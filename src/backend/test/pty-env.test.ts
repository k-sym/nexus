import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPtyEnv } from '../pty/env';

test('strips npm_config_* keys (any case)', () => {
  const out = buildPtyEnv({ PATH: '/bin', npm_config_prefix: '/x', NPM_CONFIG_FOO: 'y' });
  assert.equal(out.PATH, '/bin');
  assert.ok(!('npm_config_prefix' in out));
  assert.ok(!('NPM_CONFIG_FOO' in out));
});

test('applies extra overrides over the base env', () => {
  const out = buildPtyEnv({ PATH: '/bin', NEXUS_MEMORY_PROJECT: 'old' }, { NEXUS_MEMORY_PROJECT: 'new', NEXUS_MEMORY_READONLY: '1' });
  assert.equal(out.NEXUS_MEMORY_PROJECT, 'new');
  assert.equal(out.NEXUS_MEMORY_READONLY, '1');
});

test('skips undefined base values', () => {
  const out = buildPtyEnv({ PATH: '/bin', UNDEF: undefined });
  assert.ok(!('UNDEF' in out));
});
