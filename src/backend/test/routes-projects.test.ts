import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerProjectRoutes } from '../routes/projects';
import { loadConfig, saveConfig } from '../config';

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-routes-test-'));
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
  const insertProject = db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertProject.run('project-a', 'alpha', 'Alpha', dir, 0, now, now);
  insertProject.run('project-b', 'beta', 'Beta', dir, 1, now, now);
  insertProject.run('project-c', 'charlie', 'Charlie', dir, 2, now, now);

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerProjectRoutes);
  return { app, db, dir };
}

test('GET /api/projects includes task and active chat session counts', async () => {
  const { app, db, dir } = makeApp();
  try {
    const now = new Date().toISOString();
    const insertTask = db.prepare(
      'INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertTask.run('task-1', 'project-a', 'Task 1', now, now);
    insertTask.run('task-2', 'project-a', 'Task 2', now, now);
    insertTask.run('task-3', 'project-b', 'Task 3', now, now);

    const insertThread = db.prepare(
      'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertThread.run('thread-1', 'project-a', 'Active A', now, now, null);
    insertThread.run('thread-2', 'project-a', 'Archived A', now, now, now);
    insertThread.run('thread-3', 'project-b', 'Active B', now, now, null);

    const res = await app.inject({ method: 'GET', url: '/api/projects' });

    assert.equal(res.statusCode, 200);
    const projects = res.json();
    assert.deepEqual(
      projects.map((project: { id: string; task_count: number; chat_session_count: number }) => ({
        id: project.id,
        task_count: project.task_count,
        chat_session_count: project.chat_session_count,
      })),
      [
        { id: 'project-a', task_count: 2, chat_session_count: 1 },
        { id: 'project-b', task_count: 1, chat_session_count: 1 },
        { id: 'project-c', task_count: 0, chat_session_count: 0 },
      ],
    );
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/projects/:id/files/preview returns project-local markdown text', async () => {
  const { app, db, dir } = makeApp();
  try {
    const filePath = join(dir, 'project_docs', 'design', 'preview.md');
    mkdirSync(join(dir, 'project_docs', 'design'), { recursive: true });
    writeFileSync(filePath, '# Preview\n\nGenerated plan.');

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/project-a/files/preview?path=${encodeURIComponent(filePath)}`,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      path: realpathSync(filePath),
      name: 'preview.md',
      mimeType: 'text/markdown',
      kind: 'text',
      size: 26,
      content: '# Preview\n\nGenerated plan.',
    });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/projects/:id/files/preview resolves relative paths from the project root', async () => {
  const { app, db, dir } = makeApp();
  try {
    const relativePath = join('output', 'stick-man-640x480.png');
    const filePath = join(dir, relativePath);
    mkdirSync(join(dir, 'output'), { recursive: true });
    writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/project-a/files/preview?path=${encodeURIComponent(relativePath)}`,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      path: realpathSync(filePath),
      name: 'stick-man-640x480.png',
      mimeType: 'image/png',
      kind: 'image',
      size: 8,
      data: 'iVBORw0KGgo=',
    });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/projects/:id/files/preview resolves bare filenames from the project root', async () => {
  const { app, db, dir } = makeApp();
  try {
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, '# Test\n\nGenerated.');

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/project-a/files/preview?path=${encodeURIComponent('test.md')}`,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      path: realpathSync(filePath),
      name: 'test.md',
      mimeType: 'text/markdown',
      kind: 'text',
      size: 18,
      content: '# Test\n\nGenerated.',
    });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/projects/:id/files/preview rejects paths outside the project', async () => {
  const { app, db, dir } = makeApp();
  try {
    const outsidePath = join(tmpdir(), 'nexus-outside-preview.md');
    writeFileSync(outsidePath, 'outside');

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/project-a/files/preview?path=${encodeURIComponent(outsidePath)}`,
    });

    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /Forbidden/i);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PUT /api/projects/order persists the sidebar project order', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/order',
      payload: { project_ids: ['project-c', 'project-a', 'project-b'] },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().map((p: { id: string }) => p.id), ['project-c', 'project-a', 'project-b']);

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.deepEqual(list.json().map((p: { id: string }) => p.id), ['project-c', 'project-a', 'project-b']);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/github/sync creates triage tasks from open issues', async () => {
  const { app, db, dir } = makeApp();
  try {
    // Point project-a at a GitHub remote and stub the network via the route's fetch.
    db.prepare("UPDATE projects SET git_remote = 'git@github.com:o/r.git' WHERE id = 'project-a'").run();
    const { __resetThrottle } = await import('../github/sync');
    __resetThrottle();

    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(
      JSON.stringify([{ number: 7, title: 'Bug', body: 'b', html_url: 'https://github.com/o/r/issues/7' }]),
      { status: 200 },
    );
    try {
      const res = await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { created: 1, total: 1 });
    } finally {
      (globalThis as any).fetch = realFetch;
    }

    const row = db.prepare("SELECT title, status, external_id FROM tasks WHERE project_id = 'project-a'").get() as any;
    assert.equal(row.title, '[#7] Bug');
    assert.equal(row.status, 'triage');
    assert.equal(row.external_id, '7');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/github/sync dedups identical failure notifications and re-notifies after success', async () => {
  const { app, db, dir } = makeApp();
  const { __resetThrottle, __resetErrorState } = await import('../github/sync');
  const { __primeTokenCache } = await import('../github/token');
  const realFetch = globalThis.fetch;
  const realToken = process.env.GITHUB_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;
    __resetThrottle();
    __resetErrorState();
    // Prime the resolver cache to null so it never shells out to the real gh.
    __primeTokenCache(null);

    db.prepare("UPDATE projects SET git_remote = 'git@github.com:o/r.git' WHERE id = 'project-a'").run();

    // First two syncs both fail with the same HTTP 404 — only one toast.
    (globalThis as any).fetch = async () => new Response('Not Found', { status: 404 });

    const first = await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { created: 0, total: 0 });

    __resetThrottle(); // bypass the per-project throttle so the route runs again
    const second = await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });
    assert.deepEqual(second.json(), { created: 0, total: 0 });

    const afterTwoFails = db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE title = 'GitHub sync failed'",
    ).get() as { n: number };
    assert.equal(afterTwoFails.n, 1);

    // A successful sync clears the remembered error...
    (globalThis as any).fetch = async () => new Response('[]', { status: 200 });
    __resetThrottle();
    const ok = await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });
    assert.deepEqual(ok.json(), { created: 0, total: 0 });

    // ...so a later identical failure notifies again (second row).
    (globalThis as any).fetch = async () => new Response('Not Found', { status: 404 });
    __resetThrottle();
    await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });

    const finalCount = db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE title = 'GitHub sync failed'",
    ).get() as { n: number };
    assert.equal(finalCount.n, 2);
  } finally {
    (globalThis as any).fetch = realFetch;
    if (realToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = realToken;
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/github/sync no-ops when github is disabled in config', async () => {
  const { app, db, dir } = makeApp();
  const original = loadConfig();
  try {
    saveConfig({ ...original, github: { enabled: false } });
    db.prepare("UPDATE projects SET git_remote = 'git@github.com:o/r.git' WHERE id = 'project-a'").run();

    // Fetch must never be called while disabled; fail loudly if it is.
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      throw new Error('network should not be reached when github sync is disabled');
    };
    try {
      const res = await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { created: 0, total: 0 });
    } finally {
      (globalThis as any).fetch = realFetch;
    }

    const count = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'project-a'").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    saveConfig(original);
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
