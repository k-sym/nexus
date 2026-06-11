import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadLocalEnvFile } from '../env';

test('loadLocalEnvFile loads blank-safe local env values without overwriting exported variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'));
  const previousToken = process.env.JIRA_TOKEN;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  const previousLocalOnly = process.env.NEXUS_ENV_TEST_ONLY;

  try {
    process.env.JIRA_TOKEN = 'already-exported';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.NEXUS_ENV_TEST_ONLY;

    writeFileSync(
      join(dir, '.env'),
      [
        '# local Nexus secrets',
        'JIRA_TOKEN=from-file',
        'OPENROUTER_API_KEY="sk-or-test"',
        'NEXUS_ENV_TEST_ONLY=hello world',
        '',
      ].join('\n'),
    );

    const loaded = loadLocalEnvFile(join(dir, '.env'));

    assert.equal(loaded, true);
    assert.equal(process.env.JIRA_TOKEN, 'already-exported');
    assert.equal(process.env.OPENROUTER_API_KEY, 'sk-or-test');
    assert.equal(process.env.NEXUS_ENV_TEST_ONLY, 'hello world');
  } finally {
    if (previousToken === undefined) delete process.env.JIRA_TOKEN;
    else process.env.JIRA_TOKEN = previousToken;
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
    if (previousLocalOnly === undefined) delete process.env.NEXUS_ENV_TEST_ONLY;
    else process.env.NEXUS_ENV_TEST_ONLY = previousLocalOnly;
    rmSync(dir, { recursive: true, force: true });
  }
});
