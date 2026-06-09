import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

void existsSync; // keep lint quiet if some tests don't use it directly

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATION_SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'migrate-chats-to-zosma.cjs');
test('migrate-chats-to-zosma writes pi-format JSONL sessions and simplifies chat_threads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-migrate-test-'));
  const dbPath = join(dir, 'test.db');
  // The migration script writes sessions to $HOME/.nexus/sessions, so
  // the SESSIONS_DIR var here is just for cleanliness — the assertion
  // uses $HOME/.nexus/sessions.
  const homeNexus = join(dir, '.nexus');
  const sessionsDir = join(homeNexus, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  // Fixture: a project with one thread and two messages.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, config_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, attachments_json TEXT DEFAULT '[]', message_type TEXT DEFAULT 'text', structured_json TEXT, thinking TEXT, tool_calls TEXT, created_at TEXT);
    CREATE TABLE personas (id TEXT PRIMARY KEY, name TEXT, slug TEXT, config_yaml TEXT, created_at TEXT);
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, kind TEXT, base_url TEXT, api_key TEXT, default_model TEXT, models TEXT, args TEXT, created_at TEXT);
  `);
  const now = '2026-06-09T13:00:00.000Z';
  const now2 = '2026-06-09T13:00:05.000Z';
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'p1',
    'p1',
    'P1',
    '/tmp/proj',
    '{}',
    now,
    now,
  );
  db.prepare('INSERT INTO chat_threads VALUES (?, ?, ?, ?, ?, ?)').run(
    't1',
    'p1',
    'T1',
    now,
    now,
    null,
  );
  db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm1',
    't1',
    'user',
    'hello',
    '[]',
    'text',
    null,
    null,
    null,
    now,
  );
  db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm2',
    't1',
    'assistant',
    'hi back',
    '[]',
    'text',
    null,
    'thinking here',
    null,
    now2,
  );
  db.close();

  // Run the migration with NEXUS_DB + HOME redirected.
  const result = spawnSync('node', [MIGRATION_SCRIPT], {
    env: { ...process.env, NEXUS_DB: dbPath, HOME: dir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `migration failed: ${result.stderr}`);

  // Session file written with parentId chain.
  const sessionFiles = readdirSync(join(sessionsDir, 'tmp_proj'));
  assert.ok(sessionFiles.length > 0, `no session files written; got: ${sessionFiles.join(', ')}`);
  const sessionFile = sessionFiles.find((f) => f.includes('_t1.jsonl'));
  assert.ok(sessionFile, `session file for t1 exists; got: ${sessionFiles.join(', ')}`);
  const lines = readFileSync(join(sessionsDir, 'tmp_proj', sessionFile), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 3, 'header + 2 messages');
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'session');
  assert.equal(header.id, 't1');
  assert.equal(header.cwd, '/tmp/proj');
  assert.equal(header.version, 1);
  const m1 = JSON.parse(lines[1]);
  const m2 = JSON.parse(lines[2]);
  assert.equal(m1.parentId, null);
  assert.equal(m1.type, 'message');
  assert.equal(m1.message.role, 'user');
  assert.equal(m1.message.content, 'hello');
  assert.equal(m2.parentId, m1.id);
  assert.equal(m2.message.role, 'assistant');
  assert.equal(m2.message.content, 'hi back');
  assert.equal(m2.message.thinking, 'thinking here');

  // Schema simplified.
  const db2 = new Database(dbPath);
  const cols = db2.pragma('table_info(chat_threads)').map((c) => c.name);
  assert.ok(cols.includes('zosma_session_id'), 'zosma_session_id column added');
  assert.equal(db2.pragma('user_version', { simple: true }), 101, 'user_version bumped to 101');
  // The new schema must not have the legacy chat_threads columns — those
  // were the cause of the post-merge "NOT NULL constraint failed:
  // chat_threads.agent_id" 500 in the chat route's INSERT.
  for (const legacy of ['agent_id', 'agent_session_id', 'mode', 'launch_command']) {
    assert.ok(
      !cols.includes(legacy),
      `legacy column ${legacy} should be removed; got: ${cols.join(', ')}`,
    );
  }
  assert.ok(
    !db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'")
      .get(),
    'chat_messages table dropped',
  );
  assert.ok(
    !db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personas'")
      .get(),
    'personas table dropped',
  );
  assert.ok(
    !db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
      .get(),
    'providers table dropped',
  );
  db2.close();

  rmSync(dir, { recursive: true, force: true });
});

test('migration is idempotent: second run is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-migrate-test-'));
  const dbPath = join(dir, 'test.db');
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  // Empty DB with the migration already applied.
  const db = new Database(dbPath);
  db.pragma('user_version = 101');
  db.close();

  const result = spawnSync('node', [MIGRATION_SCRIPT], {
    env: { ...process.env, NEXUS_DB: dbPath, HOME: dir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `migration failed: ${result.stderr}`);
  assert.match(result.stdout, /already applied/);
  assert.equal(existsSync(sessionsDir), true, 'sessions dir is left in place');

  rmSync(dir, { recursive: true, force: true });
});

test('v101 step rebuilds chat_threads on a v100 DB that still has legacy columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-migrate-test-'));
  const dbPath = join(dir, 'test.db');
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  // Fixture: a v100 DB whose chat_threads still has the legacy columns
  // (this is the user's exact situation post-merge).
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, config_json TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      agent_session_id TEXT,
      mode TEXT NOT NULL DEFAULT 'chat',
      launch_command TEXT,
      zosma_session_id TEXT
    );
  `);
  db.pragma('user_version = 100');
  const now = '2026-06-09T13:00:00.000Z';
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'p1', 'p1', 'P1', '/tmp/proj', '{}', now, now,
  );
  db.prepare(`INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at, zosma_session_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    't1', 'p1', 'developer', 'Legacy', now, now, 't1',
  );
  db.close();

  const result = spawnSync('node', [MIGRATION_SCRIPT], {
    env: { ...process.env, NEXUS_DB: dbPath, HOME: dir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `migration failed: ${result.stderr}`);

  const db2 = new Database(dbPath);
  const cols = db2.pragma('table_info(chat_threads)').map((c) => c.name);
  for (const legacy of ['agent_id', 'agent_session_id', 'mode', 'launch_command']) {
    assert.ok(!cols.includes(legacy), `legacy ${legacy} should be gone; got: ${cols.join(', ')}`);
  }
  assert.equal(db2.pragma('user_version', { simple: true }), 101);

  // Row survived the rebuild.
  const row = db2.prepare('SELECT id, project_id, title, zosma_session_id FROM chat_threads').get();
  assert.equal(row.id, 't1');
  assert.equal(row.title, 'Legacy');
  assert.equal(row.zosma_session_id, 't1');

  // And a fresh INSERT (matching the route's pattern, no agent_id) now works.
  db2.prepare(
    `INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('t2', 'p1', 'Fresh', now, now);
  assert.ok(db2.prepare('SELECT * FROM chat_threads WHERE id = ?').get('t2'));

  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
