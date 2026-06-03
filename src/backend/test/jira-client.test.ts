import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapIssues, fetchJiraTickets, JiraError } from '../jira/client';

const ISSUE = {
  key: 'SUP-42',
  fields: {
    summary: 'Printer on fire',
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    assignee: { displayName: 'Keith Symmonds' },
    created: '2026-05-01T09:00:00.000+0100',
    updated: '2026-06-01T10:30:00.000+0100',
  },
};

test('mapIssues maps fields and builds the browse url', () => {
  const [t] = mapIssues([ISSUE as any], 'example.atlassian.net');
  assert.deepEqual(t, {
    key: 'SUP-42',
    summary: 'Printer on fire',
    status: 'In Progress',
    priority: 'High',
    assignee: 'Keith Symmonds',
    created: '2026-05-01',
    updated: '2026-06-01',
    url: 'https://example.atlassian.net/browse/SUP-42',
  });
});

test('mapIssues falls back for missing priority/assignee', () => {
  const [t] = mapIssues([{ key: 'SUP-1', fields: { summary: 's' } } as any], 'h');
  assert.equal(t.priority, 'Medium');
  assert.equal(t.assignee, null);
});

test('fetchJiraTickets throws JiraError with status + snippet on non-2xx', async () => {
  const fakeFetch = async () => new Response('nope: bad token', { status: 401 });
  await assert.rejects(
    () => fetchJiraTickets({ user: 'u', instance: 'h', project: 'SUP' }, 'tok', fakeFetch as any),
    (err: unknown) => {
      assert.ok(err instanceof JiraError);
      assert.equal((err as JiraError).status, 401);
      assert.match((err as JiraError).message, /401/);
      assert.match((err as JiraError).message, /bad token/);
      return true;
    },
  );
});

test('fetchJiraTickets returns mapped tickets on success', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ issues: [ISSUE] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const tickets = await fetchJiraTickets({ user: 'u', instance: 'example.atlassian.net', project: 'SUP' }, 'tok', fakeFetch as any);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].key, 'SUP-42');
});
