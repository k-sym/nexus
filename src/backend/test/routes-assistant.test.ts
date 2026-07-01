import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantRoutes } from '../routes/assistant';
import { loadConfig } from '../config';
import { getDb } from '../db';
import type { HermesFetch } from '../hermes/client';
import { ActivityManager } from '../activity/manager';

function makeApp(options: { config?: ReturnType<typeof loadConfig>; fetchImpl?: HermesFetch; activity?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-assistant-test-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  let stopActivity: (() => void) | undefined;
  if (options.activity) {
    const activity = new ActivityManager(db);
    stopActivity = activity.startListening();
    app.decorate('activity', activity);
  }
  app.register(createAssistantRoutes(() => options.config ?? {
    ...loadConfig(),
    assistant: { url: 'http://127.0.0.1:8642', api_key: 'secret' },
  }, { fetchImpl: options.fetchImpl }));
  return { app, db, dir, stopActivity };
}

async function cleanup(app: ReturnType<typeof Fastify>, db: ReturnType<typeof getDb>, dir: string, stopActivity?: () => void) {
  stopActivity?.();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

test('Assistant session routes create list read rename and delete sessions', async () => {
  const { app, db, dir } = makeApp();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions',
      payload: { title: 'Nightly checks' },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().title, 'Nightly checks');
    const sessionId = created.json().id;

    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.deepEqual(list.json().sessions.map((session: any) => session.id), [sessionId]);

    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().session.id, sessionId);
    assert.deepEqual(detail.json().messages, []);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/assistant/sessions/${sessionId}`,
      payload: { title: 'Overnight repo checks' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().title, 'Overnight repo checks');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/assistant/sessions/${sessionId}` });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().ok, true);

    const afterDelete = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.deepEqual(afterDelete.json().sessions, []);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground stream stores user assistant messages and completed run', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'remote-run-1', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-run-1')) {
      return new Response(JSON.stringify({
        run_id: 'remote-run-1',
        status: 'completed',
        session_id: 'local-session',
        output: 'Finished overnight checks.',
        usage: { total_tokens: 42 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Checks' } });
    const sessionId = created.json().id;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'Run checks tonight' },
    });

    assert.equal(streamed.statusCode, 200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events, [
      { type: 'run_start', runId: events[0].runId, remoteRunId: 'remote-run-1' },
      { type: 'text_delta', delta: 'Finished overnight checks.' },
      { type: 'complete', runId: events[0].runId, status: 'succeeded' },
    ]);

    const messages = db
      .prepare('SELECT role, content FROM assistant_session_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Array<{ role: string; content: string }>;
    assert.deepEqual(messages, [
      { role: 'user', content: 'Run checks tonight' },
      { role: 'assistant', content: 'Finished overnight checks.' },
    ]);
    const run = db.prepare('SELECT remote_run_id, status, output FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.deepEqual(run, {
      remote_run_id: 'remote-run-1',
      status: 'succeeded',
      output: 'Finished overnight checks.',
    });
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground stream treats a still-running remote run as accepted work, not a failed stream', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'remote-run-live', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-run-live')) {
      return new Response(JSON.stringify({
        run_id: 'remote-run-live',
        status: 'running',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir, stopActivity } = makeApp({ fetchImpl, activity: true });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Live remote run' } });
    const sessionId = created.json().id;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'Start long work' },
    });

    assert.equal(streamed.statusCode, 200);
    const events = streamed.body.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events, [
      { type: 'run_start', runId: events[0].runId, remoteRunId: 'remote-run-live' },
      { type: 'complete', runId: events[0].runId, status: 'running' },
    ]);

    const run = db.prepare('SELECT remote_run_id, status, error FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.deepEqual(run, {
      remote_run_id: 'remote-run-live',
      status: 'running',
      error: null,
    });
    const operation = db.prepare('SELECT status, error, last_event FROM operations WHERE id = ?').get(events[0].runId) as any;
    assert.deepEqual(operation, {
      status: 'succeeded',
      error: null,
      last_event: 'remote_run_running',
    });
  } finally {
    await cleanup(app, db, dir, stopActivity);
  }
});

test('Assistant detached run sync reconciles completed Hermes output after restart', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'remote-run-2', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-run-2')) {
      return new Response(JSON.stringify({
        run_id: 'remote-run-2',
        status: 'completed',
        output: 'The overnight run is complete.',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Overnight' } });
    const sessionId = created.json().id;
    const detached = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/runs`,
      payload: { content: 'Work while Nexus is closed' },
    });
    assert.equal(detached.statusCode, 200);
    assert.equal(detached.json().run.status, 'running');

    const sync = await app.inject({ method: 'POST', url: '/api/assistant/sync' });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().updated, 1);

    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.deepEqual(detail.json().messages.map((message: any) => [message.role, message.content]), [
      ['user', 'Work while Nexus is closed'],
      ['assistant', 'The overnight run is complete.'],
    ]);
    assert.equal(detail.json().latestRun.status, 'succeeded');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('deleting an Assistant session best-effort stops its running Hermes runs without blocking delete', async () => {
  let stopCalls = 0;
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'remote-delete-running', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-delete-running/stop')) {
      stopCalls += 1;
      return new Response('Hermes stop failed', { status: 500 });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Clear running' } });
    const sessionId = created.json().id;
    const detached = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/runs`,
      payload: { content: 'Long running work' },
    });
    assert.equal(detached.statusCode, 200);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/assistant/sessions/${sessionId}` });

    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().ok, true);
    assert.equal(stopCalls, 1);
    const remaining = (db.prepare('SELECT COUNT(*) AS count FROM assistant_sessions WHERE id = ?').get(sessionId) as { count: number }).count;
    assert.equal(remaining, 0);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('legacy Assistant thread endpoints wrap the newest Assistant session', async () => {
  const { app, db, dir } = makeApp();
  try {
    const thread = await app.inject({ method: 'GET', url: '/api/assistant/thread' });
    assert.equal(thread.statusCode, 200);
    assert.equal(thread.json().id, 'global');
    assert.deepEqual(thread.json().messages, []);

    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Wrapped' } });
    const sessionId = created.json().id;
    db.prepare(
      'INSERT INTO assistant_session_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('m1', sessionId, 'user', 'hello', '2026-07-01T08:00:00.000Z');

    const wrapped = await app.inject({ method: 'GET', url: '/api/assistant/thread' });
    assert.equal(wrapped.json().id, 'global');
    assert.deepEqual(wrapped.json().messages.map((message: any) => [message.role, message.content]), [['user', 'hello']]);

    const cleared = await app.inject({ method: 'DELETE', url: '/api/assistant/thread' });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().ok, true);
    const remaining = (db.prepare('SELECT COUNT(*) AS count FROM assistant_session_messages').get() as { count: number }).count;
    assert.equal(remaining, 0);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('POST /api/assistant/messages/stream returns a clear error when assistant config is missing', async () => {
  const { app, db, dir } = makeApp({ config: { ...loadConfig(), assistant: { url: '', api_key: '${ASSISTANT_API_KEY}' } } });
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
    await cleanup(app, db, dir);
  }
});
