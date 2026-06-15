import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenIssues, GitHubError } from '../github/client';

const ISSUE = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  html_url: `https://github.com/o/r/issues/${n}`,
  ...extra,
});

test('fetchOpenIssues requests open issues with the required headers', async () => {
  let calledUrl = '';
  let headers: Record<string, string> = {};
  const fakeFetch = async (url: string, init?: any) => {
    calledUrl = String(url);
    headers = init?.headers ?? {};
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await fetchOpenIssues({ owner: 'o', repo: 'r' }, 'tok', fakeFetch as any);
  assert.match(calledUrl, /^https:\/\/api\.github\.com\/repos\/o\/r\/issues\?/);
  assert.match(calledUrl, /state=open/);
  assert.match(calledUrl, /per_page=100/);
  assert.equal(headers['accept'], 'application/vnd.github+json');
  assert.ok(headers['user-agent'], 'sends a User-Agent');
  assert.equal(headers['authorization'], 'Bearer tok');
});

test('fetchOpenIssues omits Authorization when no token is given', async () => {
  let headers: Record<string, string> = {};
  const fakeFetch = async (_url: string, init?: any) => {
    headers = init?.headers ?? {};
    return new Response('[]', { status: 200 });
  };
  await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.equal(headers['authorization'], undefined);
});

test('fetchOpenIssues parses labels, defaulting to an empty array when absent', async () => {
  const payload = [
    ISSUE(1, { labels: [{ name: 'bug' }, { name: 'P1: high' }] }),
    ISSUE(2), // no labels field
    ISSUE(3, { labels: [] }),
  ];
  const fakeFetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  const issues = await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.deepEqual(issues.find((i) => i.number === 1)?.labels, ['bug', 'P1: high']);
  assert.deepEqual(issues.find((i) => i.number === 2)?.labels, []);
  assert.deepEqual(issues.find((i) => i.number === 3)?.labels, []);
});

test('fetchOpenIssues filters out pull requests', async () => {
  const payload = [ISSUE(1), ISSUE(2, { pull_request: { url: 'x' } }), ISSUE(3)];
  const fakeFetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  const issues = await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.deepEqual(issues.map((i) => i.number), [1, 3]);
});

test('fetchOpenIssues stops after one page when fewer than per_page results', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return new Response(JSON.stringify([ISSUE(1)]), { status: 200 }); };
  const issues = await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.equal(calls, 1);
  assert.equal(issues.length, 1);
});

test('fetchOpenIssues throws GitHubError with status on non-2xx', async () => {
  const fakeFetch = async () => new Response('Not Found', { status: 404 });
  await assert.rejects(
    () => fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal((err as GitHubError).status, 404);
      assert.match((err as GitHubError).message, /404/);
      return true;
    },
  );
});
