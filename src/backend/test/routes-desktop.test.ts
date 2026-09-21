import './support/nexus-test-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerDesktopRoutes, type DesktopCapableEngine } from '../routes/desktop.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function makeApp(overrides: Partial<Parameters<typeof registerDesktopRoutes>[1]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-desktop-route-'));
  const db = new Database(join(dir, 'nexus.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, last_model_key TEXT, claude_session_id TEXT, desktop_shared_at TEXT);
  `);
  const now = '2026-09-13T10:00:00.000Z';
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('proj-1', 'demo', 'Demo', join(dir, 'repo'), now, now);
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, last_model_key) VALUES (?, ?, ?, ?, ?, ?)').run('claude-thread', 'proj-1', 'C', now, now, 'claude-code/claude-opus-5');
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, last_model_key) VALUES (?, ?, ?, ?, ?, ?)').run('pi-thread', 'proj-1', 'P', now, now, 'openrouter/x');
  const opened: string[] = [];
  const marked: string[] = [];
  const imported: string[] = [];
  const engine: DesktopCapableEngine = {
    importSdkSession: async (threadId, cwd, sessionId) => { imported.push(`${threadId}@${cwd}:${sessionId}`); return { sessionId, appended: 7, modelKey: 'claude-code/claude-sonnet-5' }; },
    markSharedFromHere: async (threadId, _cwd, sessionId) => { marked.push(`${threadId}:${sessionId}`); },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', { sessionDirFor: () => join(dir, 'sessions') } as any);
  app.register(registerDesktopRoutes, {
    engine: () => engine,
    status: () => ({ appFound: true, indexFound: true }),
    openUrl: async (url) => { opened.push(url); },
    listSessions: async ({ dir: repo, includeProgrammatic }) => {
      assert.equal(repo, join(dir, 'repo'));
      assert.equal(includeProgrammatic, false);
      return [
        { sessionId: SESSION, summary: 'Fix the badge', lastModified: 1_700_000_000_000, firstPrompt: 'Fix the badge please', gitBranch: 'main', cwd: repo },
        { sessionId: 'ffffffff-0000-1111-2222-333333333333', summary: 'Older', lastModified: 1_600_000_000_000 },
      ];
    },
    getSessionInfo: async () => ({ sessionId: SESSION, summary: 'Fix the badge', lastModified: 0, customTitle: 'Badge work' }),
    transcriptExists: (_cwd, sessionId) => sessionId === SESSION,
    now: () => new Date('2026-09-13T11:00:00.000Z'),
    ...overrides,
  });
  await app.ready();
  return { app, db, dir, opened, marked, imported };
}

test('open hands a Claude thread to the desktop app, stamps it, and is idempotent', async () => {
  const { app, db, dir, opened, marked } = await makeApp();
  try {
    const noSession = await app.inject({ method: 'POST', url: '/api/threads/claude-thread/desktop/open' });
    assert.equal(noSession.statusCode, 409);
    assert.equal(noSession.json().kind, 'no_session');

    db.prepare('UPDATE chat_threads SET claude_session_id = ? WHERE id = ?').run(SESSION, 'claude-thread');
    const first = await app.inject({ method: 'POST', url: '/api/threads/claude-thread/desktop/open' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().url, `claude://resume?session=${SESSION}`);
    assert.equal(first.json().thread.desktop_shared_at, '2026-09-13T11:00:00.000Z');
    assert.deepEqual(opened, [`claude://resume?session=${SESSION}`]);
    assert.deepEqual(marked, [`claude-thread:${SESSION}`]);

    const again = await app.inject({ method: 'POST', url: '/api/threads/claude-thread/desktop/open' });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().thread.desktop_shared_at, '2026-09-13T11:00:00.000Z');
    assert.equal(opened.length, 2);
    assert.equal(marked.length, 1, 'the cursor is set once, at the first handoff');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('open refuses Pi threads, unknown threads and hosts without the desktop app', async () => {
  const { app, db, dir } = await makeApp();
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/threads/pi-thread/desktop/open' })).json().kind, 'engine_mismatch');
    assert.equal((await app.inject({ method: 'POST', url: '/api/threads/nope/desktop/open' })).statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const absent = await makeApp({ status: () => ({ appFound: false, indexFound: false }) });
  try {
    absent.db.prepare('UPDATE chat_threads SET claude_session_id = ? WHERE id = ?').run(SESSION, 'claude-thread');
    const res = await absent.app.inject({ method: 'POST', url: '/api/threads/claude-thread/desktop/open' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().kind, 'desktop_unavailable');
    assert.equal(absent.opened.length, 0);
  } finally {
    await absent.app.close();
    absent.db.close();
    rmSync(absent.dir, { recursive: true, force: true });
  }
});

test('the session list hides sessions already behind a thread and reports the desktop status', async () => {
  const { app, db, dir } = await makeApp();
  try {
    const all = await app.inject({ method: 'GET', url: '/api/projects/proj-1/desktop/sessions' });
    assert.equal(all.statusCode, 200);
    assert.deepEqual(all.json().sessions.map((s: any) => s.id), [SESSION, 'ffffffff-0000-1111-2222-333333333333']);
    assert.equal(all.json().sessions[0].title, 'Fix the badge');
    assert.equal(all.json().sessions[0].git_branch, 'main');
    assert.deepEqual(all.json().desktop, { appFound: true, indexFound: true });

    db.prepare('UPDATE chat_threads SET claude_session_id = ? WHERE id = ?').run(SESSION, 'claude-thread');
    const filtered = await app.inject({ method: 'GET', url: '/api/projects/proj-1/desktop/sessions' });
    assert.deepEqual(filtered.json().sessions.map((s: any) => s.id), ['ffffffff-0000-1111-2222-333333333333']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects/nope/desktop/sessions' })).statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import creates a shared thread from a transcript and refuses duplicates and bad ids', async () => {
  const { app, db, dir, imported } = await makeApp();
  try {
    const res = await app.inject({ method: 'POST', url: `/api/projects/proj-1/desktop/sessions/${SESSION}/import` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.appended, 7);
    assert.equal(body.thread.title, 'Badge work');
    assert.equal(body.thread.claude_session_id, SESSION);
    assert.equal(body.thread.desktop_shared_at, '2026-09-13T11:00:00.000Z');
    assert.equal(body.thread.last_model_key, 'claude-code/claude-sonnet-5');
    assert.equal(imported.length, 1);
    assert.ok(imported[0].endsWith(`@${join(dir, 'repo')}:${SESSION}`));

    const dup = await app.inject({ method: 'POST', url: `/api/projects/proj-1/desktop/sessions/${SESSION}/import` });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().kind, 'already_imported');
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/proj-1/desktop/sessions/not-a-uuid/import' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/projects/proj-1/desktop/sessions/ffffffff-0000-1111-2222-333333333333/import' })).statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
