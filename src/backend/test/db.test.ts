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
