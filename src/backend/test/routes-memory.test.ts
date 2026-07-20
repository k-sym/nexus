import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerMemoryRoutes } from '../routes/memory';
import { getRelevantMemories, recallForRepoPath } from '../memory/index';

async function fakeMemoryDaemon() {
  const app = Fastify({ logger: false });
  app.post('/recall', async () => ({
    query: 'archive',
    degraded: false,
    items: [{
      id: 'mem-search-1',
      title: 'Archive',
      namespace: 'nexus',
      project: 'demo',
      category: null,
      source: 'nexus',
      score: 0.8,
      sentences: [{ id: 1, text: 'Archive sessions should preserve decisions before deletion.', score: 0.8 }],
      parentChunks: ['Full archived session memory body with the decision and rationale.'],
      body: 'Full archived session memory body with the decision and rationale.',
      created_at: '2026-06-25T09:00:00.000Z',
      updated_at: '2026-06-25T09:00:00.000Z',
      facts: [],
    }],
  }));
  app.get('/memories', async (req) => {
    const query = req.query as { q?: string };
    if (query.q) {
      return {
        query: query.q,
        degraded: false,
        items: [{
          id: 'mem-search-1',
          title: 'Archive',
          namespace: 'nexus',
          project: 'demo',
          category: null,
          source: 'nexus',
          score: 0.8,
          sentences: [{ id: 1, text: 'Archive sessions should preserve decisions before deletion.', score: 0.8 }],
          parentChunks: ['Full archived session memory body with the decision and rationale.'],
          body: 'Full archived session memory body with the decision and rationale.',
          created_at: '2026-06-25T09:00:00.000Z',
          updated_at: '2026-06-25T09:00:00.000Z',
          facts: [],
        }],
      };
    }
    return { items: [{
      id: 'mem-recent-1',
      title: 'Short daemon title',
      namespace: 'nexus',
      project: 'demo',
      category: 'chat',
      source: 'nexus',
      updated_at: '2026-06-25T09:00:00.000Z',
      body: 'Full recent memory body.',
    }] };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, 'object');
  return { app, url: `http://127.0.0.1:${address!.port}` };
}

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-memory-route-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('project-1', 'demo', 'Demo', dir, now, now);
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerMemoryRoutes);
  return {
    app,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('memory page search returns actionable records with ids while recall returns strings', async () => {
  const previousUrl = process.env.MEMORY_DAEMON_URL;
  const daemon = await fakeMemoryDaemon();
  process.env.MEMORY_DAEMON_URL = daemon.url;
  const { app, db, cleanup } = makeApp();
  try {
    const search = await app.inject({ method: 'GET', url: '/api/projects/project-1/memories?q=archive' });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(search.json(), [{
      id: 'mem-search-1',
      project_id: 'project-1',
      category: 'general',
      title: 'Archive',
      content: 'Full archived session memory body with the decision and rationale.',
      source: 'nexus',
      created_at: '2026-06-25T09:00:00.000Z',
      updated_at: '2026-06-25T09:00:00.000Z',
    }]);

    const recalled = await getRelevantMemories(db, 'project-1', 'archive');
    assert.deepEqual(recalled, ['Archive sessions should preserve decisions before deletion.']);
  } finally {
    process.env.MEMORY_DAEMON_URL = previousUrl;
    await app.close();
    await daemon.app.close();
    cleanup();
  }
});

test('recallForRepoPath resolves the project owning a cwd, and stays quiet for untracked ones', async () => {
  const previousUrl = process.env.MEMORY_DAEMON_URL;
  const daemon = await fakeMemoryDaemon();
  process.env.MEMORY_DAEMON_URL = daemon.url;
  const { app, db, cleanup } = makeApp();
  try {
    const repoPath = (db.prepare('SELECT repo_path FROM projects WHERE id = ?').get('project-1') as { repo_path: string }).repo_path;

    // The pi session knows its cwd, not its project id — this is the bridge.
    assert.deepEqual(
      await recallForRepoPath(db, repoPath, 'archive'),
      ['Archive sessions should preserve decisions before deletion.'],
    );

    // A cwd outside any project has no project memories, so recall never reaches the daemon.
    assert.deepEqual(await recallForRepoPath(db, '/not/a/nexus/project', 'archive'), []);
  } finally {
    process.env.MEMORY_DAEMON_URL = previousUrl;
    await app.close();
    await daemon.app.close();
    cleanup();
  }
});
