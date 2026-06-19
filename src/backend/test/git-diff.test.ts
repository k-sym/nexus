import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectGitDiff, parseGitDiff } from '../git/diff';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { registerProjectRoutes } from '../routes/projects';

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

test('parseGitDiff splits staged and unstaged hunks with stable ids', () => {
  const staged = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;
  const unstaged = `diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,1 +10,2 @@
-old
+new
+extra
`;
  const parsed = [...parseGitDiff(staged, true), ...parseGitDiff(unstaged, false)];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'staged:0:src/a.ts:-1:+1');
  assert.equal(parsed[0].file, 'src/a.ts');
  assert.equal(parsed[0].diff.includes('+const b = 2;'), true);
  assert.equal(parsed[1].id, 'unstaged:0:src/b.ts:-10:+10');
});

test('getProjectGitDiff returns structured staged and unstaged tracked diffs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-git-diff-'));
  try {
    runGit(dir, ['init']);
    runGit(dir, ['config', 'user.email', 'a@example.com']);
    runGit(dir, ['config', 'user.name', 'A Person']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'const a = 1;\nconst c = 3;\n');
    runGit(dir, ['add', 'src/a.ts']);
    runGit(dir, ['commit', '-m', 'initial']);

    writeFileSync(join(dir, 'src/b.ts'), 'old\n');
    runGit(dir, ['add', 'src/b.ts']);
    runGit(dir, ['commit', '-m', 'add b']);

    writeFileSync(join(dir, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    runGit(dir, ['add', 'src/a.ts']);
    writeFileSync(join(dir, 'src/b.ts'), 'new\nextra\n');

    writeFileSync(join(dir, 'untracked.txt'), 'skip me\n');

    const state = getProjectGitDiff({ id: 'p', repo_path: dir, git_remote: '' } as any);
    assert.equal(state.ok, true);
    if (!state.ok) throw new Error('expected ok diff state');
    assert.equal(state.has_changes, true);
    assert.equal(state.summary.untracked_files[0], 'untracked.txt');
    assert.equal(state.hunks.length, 2);
    assert.equal(state.hunks.some((h) => h.file === 'src/a.ts' && h.staged), true);
    assert.equal(state.hunks.some((h) => h.file === 'src/b.ts' && !h.staged), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getProjectGitDiff returns not_git_repo for non-git paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-not-git-'));
  try {
    const state = getProjectGitDiff({ id: 'p', repo_path: dir, git_remote: '' } as any);
    assert.deepEqual(state, {
      ok: false,
      reason: 'not_git_repo',
      message: 'Not a git repository',
      repo_path: dir,
      git_remote: '',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRouteApp(repoPath: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-diff-route-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      git_remote TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent TEXT,
      due_date TEXT,
      external_source TEXT,
      external_id TEXT,
      model_key TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New Session',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen_at TEXT
    );
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-a', 'alpha', 'Alpha', repoPath, 0, now, now);
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('task-a', 'project-a', 'Review ambient diff', 'review', 'medium', now, now);
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerProjectRoutes);
  return { app, db, dir };
}

test('GET /api/projects/:id/git/diff returns not_git_repo for project paths outside git', async () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'nexus-route-not-git-'));
  const { app, db, dir } = makeRouteApp(nonGit);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: false, reason: 'not_git_repo', repo_path: nonGit, git_remote: '', message: 'Not a git repository' });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/review-actions creates a provenance-rich review task', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nexus-route-git-'));
  try {
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'a@example.com']);
    runGit(repo, ['config', 'user.name', 'A Person']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/a.ts'), 'const a = 1;\nconst c = 3;\n');
    runGit(repo, ['add', 'src/a.ts']);
    runGit(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    runGit(repo, ['add', 'src/a.ts']);

    const { app, db, dir } = makeRouteApp(repo);
    try {
      const diff = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
      const hunkId = (diff.json() as any).hunks[0].id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/review-actions',
        payload: { task_id: 'task-a', action: 'ask_reviewer', hunk_id: hunkId, note: 'check edge cases' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.ok, true);
      assert.equal(body.task.status, 'review');
      assert.equal(body.task.assigned_agent, 'Reviewer');
      const task = db.prepare('SELECT title, description, status, assigned_agent FROM tasks WHERE id = ?').get(body.task.id) as any;
      assert.equal(task.status, 'review');
      assert.equal(task.assigned_agent, 'Reviewer');
      assert.match(task.description, /Source task: Review ambient diff \(task-a\)/);
      assert.match(task.description, /File: src\/a\.ts/);
      assert.match(task.description, /User note: check edge cases/);
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/review-actions assigns reviewer to source task', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nexus-route-assign-'));
  try {
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'a@example.com']);
    runGit(repo, ['config', 'user.name', 'A Person']);
    writeFileSync(join(repo, 'a.txt'), 'old\n');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'a.txt'), 'new\n');

    const { app, db, dir } = makeRouteApp(repo);
    try {
      const diff = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
      const hunkId = (diff.json() as any).hunks[0].id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/review-actions',
        payload: { task_id: 'task-a', action: 'assign_reviewer', hunk_id: hunkId },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as any).task.assigned_agent, 'Reviewer');
      const task = db.prepare('SELECT status, assigned_agent FROM tasks WHERE id = ?').get('task-a') as any;
      assert.equal(task.status, 'review');
      assert.equal(task.assigned_agent, 'Reviewer');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/review-actions creates a chat seed for attach_to_chat', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nexus-route-chat-'));
  try {
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'a@example.com']);
    runGit(repo, ['config', 'user.name', 'A Person']);
    writeFileSync(join(repo, 'a.txt'), 'old\n');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'a.txt'), 'new\n');

    const { app, db, dir } = makeRouteApp(repo);
    try {
      const diff = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
      const hunkId = (diff.json() as any).hunks[0].id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/review-actions',
        payload: { task_id: 'task-a', action: 'attach_to_chat', hunk_id: hunkId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.ok, true);
      assert.equal(body.thread.project_id, 'project-a');
      assert.equal(body.seed.threadId, body.thread.id);
      assert.match(body.seed.prompt, /Source task: Review ambient diff \(task-a\)/);
      const thread = db.prepare('SELECT id, project_id, title FROM chat_threads WHERE id = ?').get(body.thread.id) as any;
      assert.equal(thread.project_id, 'project-a');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

