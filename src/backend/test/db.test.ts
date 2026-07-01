import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getDb } from '../db';

test('chat_messages has message_type + structured_json columns', () => {
  const base = join(tmpdir(), `nexus-dbtest-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(chat_messages)') as { name: string }[]).map(c => c.name);
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(cols.includes('message_type'), 'message_type column present');
  assert.ok(cols.includes('structured_json'), 'structured_json column present');
});

test('tasks has a thread_id column linking to a chat thread', () => {
  const base = join(tmpdir(), `nexus-dbtest-tid-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(cols.includes('thread_id'), 'thread_id column present on tasks');
});

test('migrates existing chat_messages tables with attachments_json', () => {
  const base = join(tmpdir(), `nexus-dbtest-attachments-${process.pid}-${Date.now()}.db`);
  const oldDb = new Database(base);
  oldDb.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text',
      structured_json TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at TEXT NOT NULL
    );
  `);
  oldDb.close();

  const db = getDb(base);
  const cols = (db.pragma('table_info(chat_messages)') as { name: string }[]).map((c) => c.name);
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });

  assert.ok(cols.includes('attachments_json'), 'attachments_json column present on migrated chat_messages');
});

test('migrations add ticket description columns', () => {
  const base = join(tmpdir(), `nexus-dbmig-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(tickets)') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('description_adf'));
  assert.ok(cols.includes('description_fetched_at'));
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
});

test('migrations create braindump_ideas table', () => {
  const base = join(tmpdir(), `nexus-dbmig2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='braindump_ideas'").get();
  assert.ok(row, 'braindump_ideas table should exist');
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
});

test('assistant session tables exist with run tracking columns', () => {
  const base = join(tmpdir(), `nexus-assistant-schema-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);

  const sessionCols = (db.pragma('table_info(assistant_sessions)') as { name: string }[]).map((c) => c.name);
  const messageCols = (db.pragma('table_info(assistant_session_messages)') as { name: string }[]).map((c) => c.name);
  const runCols = (db.pragma('table_info(assistant_runs)') as { name: string }[]).map((c) => c.name);

  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });

  assert.deepEqual(
    ['id', 'title', 'remote_session_id', 'remote_conversation_key', 'status', 'last_run_id', 'created_at', 'updated_at', 'archived_at']
      .every((col) => sessionCols.includes(col)),
    true,
  );
  assert.deepEqual(
    ['id', 'session_id', 'remote_message_id', 'role', 'content', 'event_json', 'created_at']
      .every((col) => messageCols.includes(col)),
    true,
  );
  assert.deepEqual(
    ['id', 'session_id', 'remote_run_id', 'remote_job_id', 'kind', 'status', 'input', 'output', 'error', 'usage_json', 'started_at', 'completed_at', 'updated_at']
      .every((col) => runCols.includes(col)),
    true,
  );
});

test('migrates legacy assistant_messages into one assistant session once', () => {
  const base = join(tmpdir(), `nexus-assistant-import-${process.pid}-${Date.now()}.db`);
  const oldDb = new Database(base);
  oldDb.exec(`
    CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  oldDb.prepare('INSERT INTO assistant_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)').run(
    'legacy-user',
    'user',
    'Start overnight work',
    '2026-07-01T08:00:00.000Z',
  );
  oldDb.prepare('INSERT INTO assistant_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)').run(
    'legacy-assistant',
    'assistant',
    'Queued.',
    '2026-07-01T08:01:00.000Z',
  );
  oldDb.close();

  const db = getDb(base);
  const session = db.prepare('SELECT id, title, status FROM assistant_sessions').get() as
    | { id: string; title: string; status: string }
    | undefined;
  const messages = db
    .prepare('SELECT id, session_id, role, content, created_at FROM assistant_session_messages ORDER BY created_at ASC')
    .all() as Array<{ id: string; session_id: string; role: string; content: string; created_at: string }>;

  assert.ok(session, 'imported assistant session should exist');
  assert.equal(session.title, 'Imported Assistant Session');
  assert.equal(session.status, 'idle');
  assert.deepEqual(messages.map((message) => message.id), ['legacy-user', 'legacy-assistant']);
  assert.deepEqual(messages.map((message) => message.session_id), [session.id, session.id]);
  assert.deepEqual(messages.map((message) => message.content), ['Start overnight work', 'Queued.']);
  db.close();

  const reopened = getDb(base);
  const sessionCount = (reopened.prepare('SELECT COUNT(*) AS count FROM assistant_sessions').get() as { count: number }).count;
  const messageCount = (reopened.prepare('SELECT COUNT(*) AS count FROM assistant_session_messages').get() as { count: number }).count;
  reopened.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });

  assert.equal(sessionCount, 1);
  assert.equal(messageCount, 2);
});
