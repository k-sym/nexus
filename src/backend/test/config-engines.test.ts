import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_SESSION_CUSTOM_TYPE } from '@nexus/shared';
import { defaultConfigForTests } from '../config';

test('default config has a subscription-first claude engine block', () => {
  const config = defaultConfigForTests();
  assert.deepEqual(config.engines, {
    claude: {
      enabled: true,
      auth: 'subscription',
      oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}',
      executable_path: '',
    },
  });
});

test('engine session custom entry type is namespaced like the run entries', () => {
  assert.equal(ENGINE_SESSION_CUSTOM_TYPE, 'nexus.engine_session');
});
