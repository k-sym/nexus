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

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function ndjsonEvents(payload: string): any[] {
  return payload.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function makeApp(options: { config?: ReturnType<typeof loadConfig>; fetchImpl?: HermesFetch; activity?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-assistant-test-'));
  const assistantSessionDir = join(dir, 'assistant-sessions');
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
  }, { fetchImpl: options.fetchImpl, uploadRoot: dir, assistantSessionDir }));
  return { app, db, dir, assistantSessionDir, stopActivity };
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

test('session detail reconstructs a rich transcript from Pi entries', async () => {
  const { app, db, dir, assistantSessionDir } = makeApp({});
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;
    // Seed Pi store directly with a completed tool turn.
    const s = await import('../pi/assistant-session');
    const sm = await s.openAssistantSession(sessionId, assistantSessionDir);
    s.appendRunStart(sm, { event: 'start', runId: 'r1', threadId: sessionId, startedAt: '2026-07-02T10:00:00.000Z' });
    s.appendUserMessage(sm, 'hi');
    const aId = s.appendAssistantMessage(sm, { text: 'ok', toolCalls: [{ type: 'toolCall', id: 'c1', name: 'read_file', arguments: {} }] });
    s.appendToolResult(sm, { toolCallId: 'c1', toolName: 'read_file', output: 'body' });
    s.appendRunEnd(sm, { event: 'end', runId: 'r1', threadId: sessionId, assistantEntryId: aId, completedAt: '2026-07-02T10:00:01.000Z', status: 'completed' });

    const res = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const msgs = res.json().messages as any[];
    const assistant = msgs.find((m) => m.role === 'assistant' || m.message?.role === 'assistant');
    assert.ok(assistant, 'assistant message reconstructed');
    assert.ok(JSON.stringify(assistant).includes('read_file'), 'tool activity present on reload');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('session detail lazily seeds Pi store from legacy messages', async () => {
  const { app, db, dir, assistantSessionDir } = makeApp({});
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Old' } });
    const sessionId = created.json().id;
    const now = '2026-07-01T00:00:00.000Z';
    db.prepare(`INSERT INTO assistant_session_messages (id, session_id, remote_message_id, role, content, attachments_json, event_json, created_at) VALUES (?, ?, NULL, ?, ?, '[]', NULL, ?)`)
      .run('m1', sessionId, 'user', 'legacy question', now);
    db.prepare(`INSERT INTO assistant_session_messages (id, session_id, remote_message_id, role, content, attachments_json, event_json, created_at) VALUES (?, ?, NULL, ?, ?, '[]', NULL, ?)`)
      .run('m2', sessionId, 'assistant', 'legacy answer', now);

    const res = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const blob = JSON.stringify(res.json().messages);
    assert.ok(blob.includes('legacy question') && blob.includes('legacy answer'));
    const entries = (await (await import('../pi/assistant-session')).readAssistantEntries(sessionId, assistantSessionDir)) as any[];
    assert.equal(entries.filter((e) => e.type === 'message').length, 2, 'legacy rows seeded into Pi store');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground stream stores user assistant messages and completed run', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).endsWith('/v1/responses')) {
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Finished overnight checks."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        'data: [DONE]\n\n',
      ]);
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
    const events = ndjsonEvents(streamed.body);
    const kinds = events.map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, ['run_start', 'message_update', 'run_end']);
    const runEnd = events.find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'completed');

    const messages = db
      .prepare('SELECT role, content FROM assistant_session_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Array<{ role: string; content: string }>;
    assert.deepEqual(messages, [
      { role: 'user', content: 'Run checks tonight' },
      { role: 'assistant', content: 'Finished overnight checks.' },
    ]);
    const run = db.prepare('SELECT status, output FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.deepEqual(run, {
      status: 'succeeded',
      output: 'Finished overnight checks.',
    });
  } finally {
    await cleanup(app, db, dir);
  }
});

test('streamSessionTurn streams structured run/tool/text events from /v1/responses', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).endsWith('/v1/responses')) {
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Reading."}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","name":"read_file","arguments":{"path":"/tmp/x"}}}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"call_1","output":"hi"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":" Done."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'read the file' },
    });
    assert.equal(res.statusCode, 200);
    const events = ndjsonEvents(res.payload);
    const kinds = events.map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, [
      'run_start', 'message_update', 'tool_execution_start', 'tool_execution_end', 'message_update', 'run_end',
    ]);
    const toolStart = events.find((e) => e.type === 'tool_execution_start');
    assert.equal(toolStart.toolName, 'read_file');
    const toolEnd = events.find((e) => e.type === 'tool_execution_end');
    assert.equal(toolEnd.result.content[0].text, 'hi');
    const runEnd = events.find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'completed');
    // The assistant message is persisted from the accumulated text.
    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const assistantMsg = detail.json().messages.find((m: any) => m.role === 'assistant');
    assert.equal(assistantMsg.content, 'Reading. Done.');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('foreground turn persists user/assistant/tool/run entries to the Pi session', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).endsWith('/v1/responses')) {
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Reading."}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","name":"read_file","arguments":{"path":"/tmp/x"}}}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"call_1","output":"hi"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":" Done."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir, assistantSessionDir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;
    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'read it' } });

    const { readAssistantEntries } = await import('../pi/assistant-session');
    const entries = (await readAssistantEntries(sessionId, assistantSessionDir)) as any[];
    const roles = entries.filter((e) => e.type === 'message').map((e) => e.message.role);
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult']);
    const assistant = entries.find((e) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), 'Reading. Done.');
    assert.equal(assistant.message.content.find((c: any) => c.type === 'toolCall').id, 'call_1');
    const toolResult = entries.find((e) => e.type === 'message' && e.message.role === 'toolResult') as any;
    assert.equal(toolResult.message.content[0].text, 'hi');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('streamSessionTurn emits error event when /v1/responses stream yields failed event mid-stream', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).endsWith('/v1/responses')) {
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Starting work."}\n\n',
        'data: {"type":"response.failed","response":{"id":"resp_1","error":{"message":"API rate limit exceeded"}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Error test' } });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'do work' },
    });
    assert.equal(res.statusCode, 200);
    const events = ndjsonEvents(res.payload);
    const kinds = events.map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, ['run_start', 'message_update', 'error', 'run_end']);

    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, 'error event should be present');
    assert.equal(errorEvent.error, 'API rate limit exceeded');

    const runEnd = events.find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'failed');
    assert.equal(runEnd.run.error, 'API rate limit exceeded');

    const run = db.prepare('SELECT status, error FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'API rate limit exceeded');
  } finally {
    await cleanup(app, db, dir);
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

test('Assistant runs persist attachments and send Hermes saved file references', async () => {
  let hermesInput = '';
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/responses')) {
      const body = JSON.parse(String(init?.body));
      hermesInput = body.input;
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_file"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Read the attached brief."}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_file"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Files' } });
    const sessionId = created.json().id;
    const streamed = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: {
        content: 'Summarise this',
        attachments: [{
          type: 'file',
          name: 'brief.txt',
          mimeType: 'text/plain',
          data: Buffer.from('hello from file').toString('base64'),
          size: 15,
        }],
      },
    });

    assert.equal(streamed.statusCode, 200);
    assert.match(hermesInput, /^Summarise this\n\nAttached files:\n- brief\.txt: /);
    assert.match(hermesInput, /project_docs\/uploads\/brief\.txt/);
    const row = db
      .prepare('SELECT content, attachments_json FROM assistant_session_messages WHERE session_id = ? AND role = ?')
      .get(sessionId, 'user') as { content: string; attachments_json: string };
    assert.equal(row.content, 'Summarise this');
    const stored = JSON.parse(row.attachments_json);
    assert.equal(stored[0].name, 'brief.txt');
    assert.match(stored[0].path, /project_docs\/uploads\/brief\.txt$/);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground stream sends image attachments to Hermes as inline data images', async () => {
  let createdRemoteSession = '';
  let hermesChatBody: any = null;
  const imageData = Buffer.from('fake-png').toString('base64');
  const fetchImpl: HermesFetch = async (url, init) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/api/sessions') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      createdRemoteSession = body.id;
      return new Response(JSON.stringify({ object: 'hermes.session', session: { id: body.id } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (requestUrl.endsWith(`/api/sessions/${createdRemoteSession}/chat`) && init?.method === 'POST') {
      hermesChatBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        object: 'hermes.session.chat.completion',
        session_id: createdRemoteSession,
        message: { role: 'assistant', content: 'I can see the screenshot.' },
        usage: { total_tokens: 25 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${requestUrl}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Vision' } });
    const sessionId = created.json().id;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: {
        content: 'What do you see?',
        attachments: [{
          type: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          data: imageData,
          size: 8,
        }],
      },
    });

    assert.equal(streamed.statusCode, 200);
    assert.equal(createdRemoteSession, sessionId);
    assert.ok(Array.isArray(hermesChatBody.input));
    assert.deepEqual(hermesChatBody.input[0], { type: 'text', text: 'What do you see?' });
    assert.deepEqual(hermesChatBody.input[1], {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imageData}`, detail: 'high' },
    });
    assert.equal(JSON.stringify(hermesChatBody.input).includes('project_docs/uploads'), false);

    const events = ndjsonEvents(streamed.body);
    const kinds = events.map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, ['run_start', 'message_update', 'run_end']);
    const textDelta = events.find((e) => e.type === 'message_update');
    assert.equal(textDelta.assistantMessageEvent.type, 'text_delta');
    assert.equal(textDelta.assistantMessageEvent.delta, 'I can see the screenshot.');
    const runEnd = events.find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'completed');
    const row = db
      .prepare('SELECT attachments_json FROM assistant_session_messages WHERE session_id = ? AND role = ?')
      .get(sessionId, 'user') as { attachments_json: string };
    const stored = JSON.parse(row.attachments_json);
    assert.equal(stored[0].type, 'image');
    assert.match(stored[0].path, /project_docs\/uploads\/screen\.png$/);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant background handoff rejects image attachments instead of dropping them', async () => {
  const { app, db, dir } = makeApp();
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Vision background' } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${created.json().id}/runs`,
      payload: {
        content: 'Check this overnight',
        attachments: [{
          type: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          data: Buffer.from('fake-png').toString('base64'),
          size: 8,
        }],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /Background Handoff does not support image attachments/);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant sync isolates stale Hermes run_not_found failures and continues other runs', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const runId = body.input === 'stale work' ? 'remote-stale' : 'remote-current';
      return new Response(JSON.stringify({ run_id: runId, status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-stale')) {
      return new Response(JSON.stringify({
        error: {
          message: 'Run not found: remote-stale',
          type: 'invalid_request_error',
          code: 'run_not_found',
        },
      }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/v1/runs/remote-current')) {
      return new Response(JSON.stringify({
        run_id: 'remote-current',
        status: 'completed',
        output: 'Current run completed.',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const staleSession = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Stale' } });
    const staleSessionId = staleSession.json().id;
    const staleRun = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${staleSessionId}/runs`,
      payload: { content: 'stale work' },
    });
    assert.equal(staleRun.statusCode, 200);

    const currentSession = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Current' } });
    const currentSessionId = currentSession.json().id;
    const currentRun = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${currentSessionId}/runs`,
      payload: { content: 'current work' },
    });
    assert.equal(currentRun.statusCode, 200);

    const sync = await app.inject({ method: 'POST', url: '/api/assistant/sync' });

    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().updated, 2);
    const stale = db.prepare('SELECT status, error FROM assistant_runs WHERE remote_run_id = ?').get('remote-stale') as any;
    assert.equal(stale.status, 'unknown');
    assert.match(stale.error, /Run not found: remote-stale/);
    const current = db.prepare('SELECT status, output FROM assistant_runs WHERE remote_run_id = ?').get('remote-current') as any;
    assert.deepEqual(current, { status: 'succeeded', output: 'Current run completed.' });
    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${currentSessionId}` });
    assert.deepEqual(detail.json().messages.map((message: any) => [message.role, message.content]), [
      ['user', 'current work'],
      ['assistant', 'Current run completed.'],
    ]);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('deleting an Assistant session best-effort stops its running Hermes runs without blocking delete', async () => {
  let stopCalls = 0;
  let deleteCalls = 0;
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
    if (String(url).includes('/api/sessions/') && init?.method === 'DELETE') {
      deleteCalls += 1;
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    assert.equal(deleteCalls, 1);
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

function abortAwareSseResponse(chunks: string[], signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      // Do NOT close here — the stream only closes when the request is aborted,
      // simulating a remote model that keeps generating until the client hangs up.
      const onAbort = () => {
        try { controller.close(); } catch { /* already closed */ }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('POST /api/assistant/abort tears down the in-flight /v1/responses stream and finalizes the run as cancelled', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/responses')) {
      return abortAwareSseResponse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","name":"read_file","arguments":{"path":"/tmp/x"}}}\n\n',
      ], init?.signal ?? undefined);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Abort me' } });
    const sessionId = created.json().id;

    const streamP = app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'do a long task' },
    });

    // Give the handler a tick to register the run and start consuming the stream.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const abortRes = await app.inject({ method: 'POST', url: '/api/assistant/abort' });
    assert.equal(abortRes.statusCode, 200);
    assert.equal(abortRes.json().ok, true);

    const res = await streamP;
    assert.equal(res.statusCode, 200);
    const events = ndjsonEvents(res.payload);
    const runEnd = events[events.length - 1];
    assert.equal(runEnd.kind, 'run_end');
    assert.equal(runEnd.run.status, 'cancelled');
    assert.equal(runEnd.run.abortSource, 'user');

    const run = db.prepare('SELECT status FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.equal(run.status, 'cancelled');
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

test('Assistant session list includes filtered remote Hermes API sessions only', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).includes('/api/sessions?')) {
      assert.match(String(url), /source=api_server/);
      return new Response(JSON.stringify({
        sessions: [
          { id: 'remote-api-1', title: 'Remote API session', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' },
          { id: 'remote-cron-1', title: 'Cron work', source: 'cron', updated_at: '2026-07-02T09:00:00.000Z' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().sessions.map((session: any) => ({
      id: session.id,
      title: session.title,
      remoteOnly: session.remoteOnly,
      remote_session_id: session.remote_session_id,
    })), [
      {
        id: 'remote:remote-api-1',
        title: 'Remote API session',
        remoteOnly: true,
        remote_session_id: 'remote-api-1',
      },
    ]);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant session list merges remote sessions that already have local rows', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).includes('/api/sessions?')) {
      return new Response(JSON.stringify({
        sessions: [{ id: 'remote-api-1', title: 'Remote title', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    db.prepare(
      `INSERT INTO assistant_sessions (id, title, remote_session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'idle', ?, ?)`,
    ).run('local-1', 'Local title', 'remote-api-1', '2026-07-02T08:00:00.000Z', '2026-07-02T08:00:00.000Z');

    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.deepEqual(list.json().sessions.map((session: any) => session.id), ['local-1']);
    assert.equal(list.json().sessions[0].remoteOnly, false);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant import route adopts a remote Hermes session and imports messages', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/api/sessions/remote-api-1')) {
      return new Response(JSON.stringify({
        session: { id: 'remote-api-1', title: 'Remote API session', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestUrl.endsWith('/api/sessions/remote-api-1/messages')) {
      return new Response(JSON.stringify({
        messages: [
          { id: 'hm1', role: 'user', content: 'continue this', created_at: '2026-07-02T10:01:00.000Z' },
          { id: 'hm2', role: 'assistant', content: 'I can continue.', created_at: '2026-07-02T10:02:00.000Z' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${requestUrl}`);
  };
  const { app, db, dir, assistantSessionDir } = makeApp({ fetchImpl });
  try {
    const imported = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/import',
      payload: { remoteSessionId: 'remote-api-1' },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().session.remote_session_id, 'remote-api-1');
    assert.deepEqual(imported.json().messages.map((message: any) => [message.role, message.content]), [
      ['user', 'continue this'],
      ['assistant', 'I can continue.'],
    ]);

    const { readAssistantEntries } = await import('../pi/assistant-session');
    const entries = (await readAssistantEntries(imported.json().session.id, assistantSessionDir)) as any[];
    assert.deepEqual(entries.filter((e) => e.type === 'message').map((e: any) => e.message.role), ['user', 'assistant']);

    // Re-import is idempotent: no duplicate messages in the Pi store.
    const again = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/import',
      payload: { remoteSessionId: 'remote-api-1' },
    });
    assert.equal(again.statusCode, 200);
    const entries2 = (await readAssistantEntries(again.json().session.id, assistantSessionDir)) as any[];
    assert.equal(entries2.filter((e) => e.type === 'message').length, 2, 'no duplicate messages on re-import');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground send resumes an adopted remote Hermes session', async () => {
  // The foreground turn streams over /v1/responses; assert the request carries the
  // adopted remote session id rather than the local Nexus row id.
  let responsesBody: any = null;
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/responses') && init?.method === 'POST') {
      responsesBody = JSON.parse(String(init.body));
      return sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_resume"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"resumed"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_resume"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    db.prepare(
      `INSERT INTO assistant_sessions (id, title, remote_session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'idle', ?, ?)`,
    ).run('local-adopted', 'Adopted', 'remote-api-1', '2026-07-02T08:00:00.000Z', '2026-07-02T08:00:00.000Z');

    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/local-adopted/messages/stream',
      payload: { content: 'keep going' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(responsesBody.session_id, 'remote-api-1');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('foreground turns thread previous_response_id for Hermes continuity', async () => {
  const bodies: any[] = [];
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/responses')) {
      bodies.push(JSON.parse(String(init?.body)));
      const rid = `resp_${bodies.length}`;
      return sseResponse([
        `data: {"type":"response.created","response":{"id":"${rid}"}}\n\n`,
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        `data: {"type":"response.completed","response":{"id":"${rid}"}}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;

    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'turn 1' } });
    // First turn: no prior response id sent; the returned response id is persisted.
    assert.equal(bodies[0].previous_response_id, undefined);
    const afterTurn1 = db.prepare('SELECT last_response_id FROM assistant_sessions WHERE id = ?').get(sessionId) as any;
    assert.equal(afterTurn1.last_response_id, 'resp_1');

    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'turn 2' } });
    // Second turn threads the first turn's response id, and stores the new one.
    assert.equal(bodies[1].previous_response_id, 'resp_1');
    const afterTurn2 = db.prepare('SELECT last_response_id FROM assistant_sessions WHERE id = ?').get(sessionId) as any;
    assert.equal(afterTurn2.last_response_id, 'resp_2');
  } finally {
    await cleanup(app, db, dir);
  }
});
