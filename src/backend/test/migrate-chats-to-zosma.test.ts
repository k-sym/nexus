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
  assert.equal(db2.pragma('user_version', { simple: true }), 100, 'user_version bumped to 100');
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
  db.pragma('user_version = 100');
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
