import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ActivityManager } from '../activity/manager.js';
import { getDb } from '../db.js';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-activity-test-'));
  const dbPath = join(dir, 'test.db');
  const db = getDb(dbPath);
  return { db, dir };
}

test('ActivityManager persists start/update/stop events', () => {
  const { db, dir } = makeDb();
  try {
    const manager = new ActivityManager(db);
    manager.startListening();

    manager.bus.emit({
      type: 'start',
      operationId: 'op-1',
      kind: 'chat_turn',
      title: 'Demo / Test',
      projectId: 'proj-1',
      threadId: 'thread-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });

    manager.bus.emit({
      type: 'update',
      operationId: 'op-1',
      kind: 'chat_turn',
      title: 'Demo / Test',
      lastEvent: 'context_usage',
      usage: { tokens: 1000, contextWindow: 10000, percent: 10 },
    });

    manager.bus.emit({
      type: 'stop',
      operationId: 'op-1',
      kind: 'chat_turn',
      title: 'Demo / Test',
      status: 'succeeded',
    });

    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get('op-1') as any;
    assert.equal(row.status, 'succeeded');
    assert.equal(row.kind, 'chat_turn');
    assert.equal(row.project_id, 'proj-1');
    assert.equal(row.provider, 'anthropic');
    assert.ok(row.duration_ms >= 0);
    assert.ok(row.completed_at);
    assert.equal(row.last_event, 'context_usage');
    assert.equal(JSON.parse(row.usage_json).tokens, 1000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ActivityManager sweeps stale running rows on startup', () => {
  const { db, dir } = makeDb();
  try {
    db.prepare(
      `INSERT INTO operations (id, kind, status, title, started_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('op-old', 'chat_turn', 'running', 'Old run', new Date().toISOString());

    const manager = new ActivityManager(db);
    manager.startListening();

    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get('op-old') as any;
    assert.equal(row.status, 'cancelled');
    assert.ok(row.error.includes('process restarted'));
    assert.ok(row.completed_at);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ActivityManager tracks running set in memory', () => {
  const { db, dir } = makeDb();
  try {
    const manager = new ActivityManager(db);
    manager.startListening();

    manager.bus.emit({
      type: 'start',
      operationId: 'op-run',
      kind: 'assistant_stream',
      title: 'Assistant',
    });

    assert.ok(manager.isRunning('op-run'));
    assert.equal(manager.getRunning().length, 1);

    manager.bus.emit({
      type: 'stop',
      operationId: 'op-run',
      kind: 'assistant_stream',
      title: 'Assistant',
      status: 'cancelled',
    });

    assert.ok(!manager.isRunning('op-run'));
    assert.equal(manager.getRunning().length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
