import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRepo, detectGitRemote } from '../github/repo';

test('parseGitHubRepo handles SSH form', () => {
  assert.deepEqual(parseGitHubRepo('git@github.com:k-sym/nexus.git'), { owner: 'k-sym', repo: 'nexus' });
});

test('parseGitHubRepo handles HTTPS form with and without .git', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/k-sym/nexus.git'), { owner: 'k-sym', repo: 'nexus' });
  assert.deepEqual(parseGitHubRepo('https://github.com/k-sym/nexus'), { owner: 'k-sym', repo: 'nexus' });
});

test('parseGitHubRepo returns null for non-GitHub hosts', () => {
  assert.equal(parseGitHubRepo('git@gitlab.com:k-sym/nexus.git'), null);
  assert.equal(parseGitHubRepo('https://bitbucket.org/k-sym/nexus.git'), null);
});

test('parseGitHubRepo returns null for empty or garbage input', () => {
  assert.equal(parseGitHubRepo(''), null);
  assert.equal(parseGitHubRepo('not a url'), null);
});

test('detectGitRemote returns the trimmed remote url from the runner', async () => {
  const run = async () => ({ stdout: 'git@github.com:k-sym/nexus.git\n', stderr: '' });
  assert.equal(await detectGitRemote('/some/path', run), 'git@github.com:k-sym/nexus.git');
});

test('detectGitRemote returns empty string when the runner throws (no remote / not a repo)', async () => {
  const run = async () => { throw new Error('fatal: No such remote'); };
  assert.equal(await detectGitRemote('/some/path', run), '');
});
