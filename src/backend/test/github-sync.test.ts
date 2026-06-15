import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { syncGitHubIssues, __resetThrottle } from '../github/sync';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT DEFAULT '',
      repo_path TEXT, config_json TEXT DEFAULT '{}', sort_order INTEGER DEFAULT 0,
      git_remote TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium', assigned_agent TEXT, due_date TEXT,
      thread_id TEXT, external_source TEXT, external_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('p1', 'p1', 'P1', '/tmp', 'git@github.com:o/r.git', 'now', 'now');
  return db;
}

const project = (db: Database.Database) => db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as any;

function fetchReturning(issues: Array<{ number: number; title: string }>) {
  return async () => new Response(
    JSON.stringify(issues.map((i) => ({ ...i, body: 'b', html_url: `https://github.com/o/r/issues/${i.number}` }))),
    { status: 200 },
  );
}

test('first sync creates a triage task per open issue, stamped with external id', async () => {
  const db = makeDb();
  __resetThrottle();
  const res = await syncGitHubIssues(db, project(db), {
    fetchImpl: fetchReturning([{ number: 1, title: 'One' }, { number: 2, title: 'Two' }]) as any,
    now: () => 1000,
  });
  assert.deepEqual(res, { created: 2, total: 2, skippedThrottle: false });
  const rows = db.prepare("SELECT title, status, external_source, external_id FROM tasks ORDER BY external_id").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'triage');
  assert.equal(rows[0].external_source, 'github');
  assert.equal(rows[0].external_id, '1');
  assert.equal(rows[0].title, '[#1] One');
});

test('re-sync after the throttle window dedups: same issues create nothing new', async () => {
  const db = makeDb();
  __resetThrottle();
  const fetchImpl = fetchReturning([{ number: 1, title: 'One' }]) as any;
  await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 0 });
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 10_000_000 });
  assert.deepEqual(res, { created: 0, total: 1, skippedThrottle: false });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as any).c, 1);
});

test('a second call within the throttle window is a no-op', async () => {
  const db = makeDb();
  __resetThrottle();
  const fetchImpl = fetchReturning([{ number: 1, title: 'One' }, { number: 2, title: 'Two' }]) as any;
  await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 1000 });
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 2000 });
  assert.deepEqual(res, { created: 0, total: 0, skippedThrottle: true });
});

test('a moved task is not recreated (dedup is status-independent)', async () => {
  const db = makeDb();
  __resetThrottle();
  const fetchImpl = fetchReturning([{ number: 1, title: 'One' }]) as any;
  await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 0 });
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE external_id = '1'").run();
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 10_000_000 });
  assert.equal(res.created, 0);
  const row = db.prepare("SELECT status FROM tasks WHERE external_id = '1'").get() as any;
  assert.equal(row.status, 'in_progress', 'sync left the moved task untouched');
});

test('a project with no GitHub remote is a no-op', async () => {
  const db = makeDb();
  __resetThrottle();
  db.prepare("UPDATE projects SET git_remote = '' WHERE id = 'p1'").run();
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response('[]'); }) as any;
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 0 });
  assert.deepEqual(res, { created: 0, total: 0, skippedThrottle: false });
  assert.equal(called, false, 'never hits the network without a GitHub remote');
});
