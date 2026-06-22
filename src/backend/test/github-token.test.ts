import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitHubToken, resolveGitHubTokenStatus, __resetTokenCache, type GhRunner } from '../github/token';

// A live GITHUB_TOKEN in the dev shell (or .env) would mask the gh-fallback
// path under test; clear it so the fallback assertions hold regardless of env.
delete process.env.GITHUB_TOKEN;

test('GITHUB_TOKEN env var is returned without shelling out to gh', async () => {
  delete process.env.GITHUB_TOKEN;
  __resetTokenCache();
  process.env.GITHUB_TOKEN = 'env-tok';
  try {
    const runGh: GhRunner = async () => {
      throw new Error('gh should not be invoked when GITHUB_TOKEN is set');
    };
    assert.equal(await resolveGitHubToken(runGh), 'env-tok');
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('falls back to gh auth token and caches the result', async () => {
  delete process.env.GITHUB_TOKEN;
  __resetTokenCache();
  let calls = 0;
  const runGh: GhRunner = async () => {
    calls++;
    return { stdout: 'tok\n', stderr: '' };
  };
  assert.equal(await resolveGitHubToken(runGh), 'tok');
  assert.equal(calls, 1);
  // Second call uses the cache — runner is not invoked again.
  assert.equal(await resolveGitHubToken(runGh), 'tok');
  assert.equal(calls, 1);
});

test('tries later candidates when earlier gh paths throw', async () => {
  delete process.env.GITHUB_TOKEN;
  __resetTokenCache();
  const runGh: GhRunner = async (file) => {
    if (file === 'gh') throw new Error('not on PATH');
    return { stdout: 'brew-tok\n', stderr: '' };
  };
  assert.equal(await resolveGitHubToken(runGh), 'brew-tok');
});

test('returns undefined and caches null when all candidates fail', async () => {
  delete process.env.GITHUB_TOKEN;
  __resetTokenCache();
  let calls = 0;
  const runGh: GhRunner = async () => {
    calls++;
    throw new Error('gh missing');
  };
  assert.equal(await resolveGitHubToken(runGh), undefined);
  const afterFirst = calls;
  assert.ok(afterFirst >= 1);
  // Cached as null: a second call doesn't re-shell every candidate.
  assert.equal(await resolveGitHubToken(runGh), undefined);
  assert.equal(calls, afterFirst);
});

test('token status reports environment precedence without returning the token', async () => {
  __resetTokenCache();
  process.env.GITHUB_TOKEN = 'environment-secret';
  try {
    const status = await resolveGitHubTokenStatus(async () => {
      throw new Error('gh should not run');
    });
    assert.deepEqual(status, { configured: true, source: 'environment' });
    assert.equal(JSON.stringify(status).includes('environment-secret'), false);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('token status reports gh-cli fallback and absence', async () => {
  delete process.env.GITHUB_TOKEN;
  __resetTokenCache();
  assert.deepEqual(
    await resolveGitHubTokenStatus(async () => ({ stdout: 'cli-secret\n', stderr: '' })),
    { configured: true, source: 'gh-cli' },
  );

  __resetTokenCache();
  assert.deepEqual(
    await resolveGitHubTokenStatus(async () => { throw new Error('missing'); }),
    { configured: false, source: 'absent' },
  );
});
