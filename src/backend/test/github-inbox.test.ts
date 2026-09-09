import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { Project } from '@nexus/shared';
import { listOpenIssues, findOpenIssue, ensureProjectGitRemote, noteSyncError, clearSyncError, __resetInboxCache, __resetErrorState } from '../github/inbox';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', slug: 'p1', name: 'P1', badge: 'P', description: '', repo_path: '/tmp', config_json: '{}',
  sort_order: 0, git_remote: 'git@github.com:o/r.git', created_at: 'now', updated_at: 'now', ...over,
} as Project);

function fetchReturning(issues: Array<{ number: number; title: string }>) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(
      JSON.stringify(issues.map((i) => ({ ...i, body: 'b', html_url: `https://github.com/o/r/issues/${i.number}`, labels: [{ name: 'bug' }] }))),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

beforeEach(() => { __resetInboxCache(); __resetErrorState(); });

test('first read fetches, second read within the window comes from the cache', async () => {
  const { fetchImpl, calls } = fetchReturning([{ number: 7, title: 'Bug' }]);
  let now = 1_000_000;
  const first = await listOpenIssues(project(), { fetchImpl, token: 't', now: () => now });
  assert.deepEqual(first.ref, { owner: 'o', repo: 'r' });
  assert.equal(first.fromCache, false);
  assert.deepEqual(first.issues.map((i) => [i.number, i.title, i.labels]), [[7, 'Bug', ['bug']]]);
  now += 60_000;
  const second = await listOpenIssues(project(), { fetchImpl, token: 't', now: () => now });
  assert.equal(second.fromCache, true);
  assert.equal(second.issues.length, 1);
  assert.equal(calls(), 1);
  // refresh bypasses the throttle; so does the window elapsing.
  await listOpenIssues(project(), { fetchImpl, token: 't', now: () => now, refresh: true });
  assert.equal(calls(), 2);
  now += 4 * 60_000;
  await listOpenIssues(project(), { fetchImpl, token: 't', now: () => now });
  assert.equal(calls(), 3);
});

test('a failure keeps the last good list and reports the error; nothing cached gives an empty list', async () => {
  const good = fetchReturning([{ number: 1, title: 'One' }]);
  let now = 0;
  await listOpenIssues(project(), { fetchImpl: good.fetchImpl, token: 't', now: () => now });
  const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  now += 5 * 60_000;
  const events: any[] = [];
  const degraded = await listOpenIssues(project(), { fetchImpl: failing, token: 't', now: () => now, emit: (e) => events.push(e) });
  assert.equal(degraded.fromCache, true);
  assert.deepEqual(degraded.issues.map((i) => i.number), [1]);
  assert.match(degraded.error!, /HTTP 404/);
  assert.deepEqual(events.map((e) => [e.type, e.kind, e.status]), [['start', 'github_sync', undefined], ['stop', 'github_sync', 'failed']]);

  __resetInboxCache();
  const empty = await listOpenIssues(project({ id: 'p2' }), { fetchImpl: failing, token: 't', now: () => now });
  assert.deepEqual(empty.issues, []);
  assert.match(empty.error!, /HTTP 404/);
});

test('a project with no GitHub remote returns ref null without fetching', async () => {
  const { fetchImpl, calls } = fetchReturning([{ number: 1, title: 'One' }]);
  const result = await listOpenIssues(project({ git_remote: '' }), { fetchImpl, token: 't' });
  assert.equal(result.ref, null);
  assert.deepEqual(result.issues, []);
  assert.equal(calls(), 0);
});

test('findOpenIssue reads through the cache', async () => {
  const { fetchImpl, calls } = fetchReturning([{ number: 1, title: 'One' }, { number: 2, title: 'Two' }]);
  assert.equal((await findOpenIssue(project(), 2, { fetchImpl, token: 't' }))?.title, 'Two');
  assert.equal(await findOpenIssue(project(), 3, { fetchImpl, token: 't' }), null);
  assert.equal(calls(), 1);
});

test('noteSyncError dedupes identical messages until cleared', () => {
  assert.equal(noteSyncError('p1', 'HTTP 404'), true);
  assert.equal(noteSyncError('p1', 'HTTP 404'), false);
  assert.equal(noteSyncError('p1', 'HTTP 401'), true);
  clearSyncError('p1');
  assert.equal(noteSyncError('p1', 'HTTP 401'), true);
});

test('ensureProjectGitRemote backfills an empty git_remote and persists it', async () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, git_remote TEXT NOT NULL DEFAULT '', repo_path TEXT)");
  db.prepare("INSERT INTO projects (id, git_remote, repo_path) VALUES ('p1', '', '/tmp')").run();
  const updated = await ensureProjectGitRemote(db, project({ git_remote: '' }), async () => 'git@github.com:o/r.git');
  assert.equal(updated.git_remote, 'git@github.com:o/r.git');
  assert.equal((db.prepare('SELECT git_remote FROM projects WHERE id = ?').get('p1') as any).git_remote, 'git@github.com:o/r.git');
  const untouched = await ensureProjectGitRemote(db, project(), async () => { throw new Error('must not detect'); });
  assert.equal(untouched.git_remote, 'git@github.com:o/r.git');
  const none = await ensureProjectGitRemote(db, project({ id: 'p2', git_remote: '' }), async () => '');
  assert.equal(none.git_remote, '');
  db.close();
});
