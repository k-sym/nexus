import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createAssistantRoutes } from '../routes/assistant';
import { loadConfig } from '../config';

function makeApp(config = loadConfig()) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-assistant-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE assistant_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(createAssistantRoutes(() => config));
  return { app, db, dir };
}

test('GET /api/assistant/thread returns the global assistant thread with messages', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/assistant/thread' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { id: 'global', messages: [] });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/assistant/messages/stream returns a clear error when assistant config is missing', async () => {
  const { app, db, dir } = makeApp({ ...loadConfig(), assistant: { url: '', api_key: '${ASSISTANT_API_KEY}' } });
  const originalKey = process.env.ASSISTANT_API_KEY;
  try {
    delete process.env.ASSISTANT_API_KEY;
    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/messages/stream',
      payload: { content: 'Run this overnight' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Assistant URL and key must be configured in Settings.');
  } finally {
    if (originalKey === undefined) delete process.env.ASSISTANT_API_KEY;
    else process.env.ASSISTANT_API_KEY = originalKey;
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
