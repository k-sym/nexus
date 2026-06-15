import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJiraIssueDescription } from '../jira/client';

test('fetchJiraIssueDescription requests the description field and returns raw ADF', async () => {
  let calledUrl = '';
  const fakeFetch = (async (url: string) => {
    calledUrl = String(url);
    return {
      ok: true,
      json: async () => ({ fields: { description: { type: 'doc', content: [] } } }),
    } as Response;
  }) as unknown as typeof fetch;

  const adf = await fetchJiraIssueDescription(
    { user: 'me@x.test', instance: 'acme.atlassian.net', project: 'SUP' },
    'token',
    'SUP-42',
    fakeFetch,
  );
  assert.match(calledUrl, /\/rest\/api\/3\/issue\/SUP-42\?fields=description/);
  assert.deepEqual(adf, { type: 'doc', content: [] });
});

test('fetchJiraIssueDescription returns null when Jira omits the field', async () => {
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ fields: {} }) } as Response)) as unknown as typeof fetch;
  const adf = await fetchJiraIssueDescription(
    { user: 'me@x.test', instance: 'acme.atlassian.net', project: 'SUP' }, 'token', 'SUP-1', fakeFetch,
  );
  assert.equal(adf, null);
});
