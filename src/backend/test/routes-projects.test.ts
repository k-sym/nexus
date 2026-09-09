import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerProjectRoutes } from '../routes/projects';
import { getDb } from '../db';


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

test('GET /api/projects/:id/files/preview allows files through project-local symlinked directories', async () => {
  const { app, db, dir } = makeApp();
  const externalDocs = mkdtempSync(join(tmpdir(), 'nexus-project-docs-target-'));
  try {
    const symlinkPath = join(dir, 'project_docs');
    const filePath = join(symlinkPath, 'design', 'preview.md');
    mkdirSync(join(externalDocs, 'design'), { recursive: true });
    writeFileSync(join(externalDocs, 'design', 'preview.md'), '# Symlinked\n\nGenerated plan.');
    symlinkSync(externalDocs, symlinkPath, 'dir');

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/project-a/files/preview?path=${encodeURIComponent(filePath)}`,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      path: filePath,
      name: 'preview.md',
      mimeType: 'text/markdown',
      kind: 'text',
      size: 28,
      content: '# Symlinked\n\nGenerated plan.',
    });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(externalDocs, { recursive: true, force: true });
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

// PUT /api/tasks/:id updates every field with COALESCE(?, col), which makes
// absence and emptiness mean different things: an omitted field leaves the
// column alone, an empty string clears it. The iOS edit sheet depends on that
// distinction — it sends only the fields the user changed, so an emptied
// description has to travel as "" or the clear would silently do nothing and
// the old text would spring back on the next load. Uses getDb() (the real
// schema) rather than this file's hand-rolled makeApp(), whose tasks table
// predates the model_key/thread_id columns this route writes.
test('PUT /api/tasks/:id clears a description sent as "" and leaves an omitted one alone', async () => {
  const db = getDb(':memory:');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', '{}', 0, '', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','Task','Some details.','todo','medium', ?, ?)`).run(now, now);

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  await app.register(registerProjectRoutes);

  const description = () =>
    (db.prepare('SELECT description FROM tasks WHERE id = ?').get('t1') as { description: string }).description;

  try {
    // A patch that says nothing about the description must not touch it.
    const untouched = await app.inject({
      method: 'PUT', url: '/api/tasks/t1', payload: { priority: 'high' },
    });
    assert.equal(untouched.statusCode, 200);
    assert.equal(description(), 'Some details.');
    assert.equal(untouched.json().priority, 'high');

    // "" is a value, not an absence: it clears the column and stays cleared.
    const cleared = await app.inject({
      method: 'PUT', url: '/api/tasks/t1', payload: { description: '' },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().description, '');
    assert.equal(description(), '');

    const reread = await app.inject({ method: 'GET', url: '/api/projects/p1/tasks' });
    assert.equal(reread.json().find((t: { id: string }) => t.id === 't1').description, '');
  } finally {
    await app.close();
    db.close();
  }
});
