import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantRoutes, remoteSessionTitle } from '../routes/assistant';
import { loadConfig } from '../config';
import { getDb } from '../db';
import type { PartnerFetch } from '../partner/client';
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

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** `GET /v1/capabilities` as the adapter reports it. The Partner says
 * `run_submission=false`; the Hermes-era tests below opt into runs. */
function capabilitiesRes(features: { run_submission?: boolean; run_stop?: boolean } = { run_submission: true, run_stop: true }): Response {
  return jsonRes({ features: { session_create: true, ...features }, endpoints: { session_chat_stream: true } });
}

/**
 * Mock the session-scoped Partner surface the Assistant now uses:
 * `POST /api/sessions` (ensureRemoteSession), `POST /api/sessions/{id}/chat/stream`
 * (foreground send), and `GET /api/sessions/{id}/messages` (history render).
 * `frames` are raw SSE frames for the chat stream; `messages` is the transcript
 * that `/messages` returns on reload.
 */
function partnerChatMock(opts: {
  frames?: string[];
  messages?: any[];
  /** `/v1/capabilities` features; defaults to a runs-capable (Hermes-era) adapter. */
  capabilities?: { run_submission?: boolean; run_stop?: boolean };
  onChatStream?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  onOther?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
}): PartnerFetch {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith('/v1/capabilities')) return capabilitiesRes(opts.capabilities);
    if (/\/api\/sessions\/[^/]+\/chat\/stream$/.test(u)) {
      if (opts.onChatStream) return opts.onChatStream(u, init);
      return sseResponse(opts.frames ?? ['event: run.completed\ndata: {}\n\n', 'event: done\ndata: {}\n\n']);
    }
    if (/\/api\/sessions\/[^/]+\/messages$/.test(u)) {
      return jsonRes({ object: 'list', session_id: u.split('/').slice(-2)[0], data: opts.messages ?? [] });
    }
    if (u.endsWith('/api/sessions') && init?.method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return jsonRes({ session: { id: body.id ?? 'remote-created', title: body.title } });
    }
    const other = opts.onOther?.(u, init);
    if (other) return other;
    if (/\/api\/sessions\/[^/]+$/.test(u)) {
      // getSession detail (title lookup on import); harmless default.
      return jsonRes({ session: { id: u.split('/').pop() } });
    }
    throw new Error(`unexpected Partner request ${u}`);
  };
}

// A tool turn as Partner /messages returns it (assistant tool_calls + tool rows).
function toolTurnMessages(userText: string, assistantText: string) {
  return [
    { id: 'u1', role: 'user', content: userText },
    {
      id: 'a1',
      role: 'assistant',
      content: assistantText,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' } }],
    },
    { id: 't1', role: 'tool', tool_call_id: 'call_1', tool_name: 'read_file', content: 'hi' },
  ];
}

function makeApp(options: { config?: ReturnType<typeof loadConfig>; fetchImpl?: PartnerFetch; activity?: boolean } = {}) {
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

test('Idea Watcher dialogue sessions are hidden from the rail but readable by id', async () => {
  const { app, db, dir } = makeApp();
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Ordinary' } });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO assistant_sessions (id, title, status, origin, created_at, updated_at) VALUES ('idea-s1', 'Idea: X', 'idle', 'idea', ?, ?)",
    ).run(now, now);

    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.deepEqual(list.json().sessions.map((s: any) => s.id), [created.json().id]);

    // The idea's thread view still reads/streams the session through the
    // ordinary per-id routes.
    const detail = await app.inject({ method: 'GET', url: '/api/assistant/sessions/idea-s1' });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().session.id, 'idea-s1');
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

test('Assistant foreground stream persists via /chat/stream and completes the run', async () => {
  const fetchImpl = partnerChatMock({
    frames: [
      'event: run.started\ndata: {"user_message":{"role":"user","content":"Run checks tonight"}}\n\n',
      'event: assistant.delta\ndata: {"delta":"Finished overnight checks."}\n\n',
      'event: run.completed\ndata: {}\n\n',
      'event: done\ndata: {}\n\n',
    ],
    messages: [
      { id: 'u1', role: 'user', content: 'Run checks tonight' },
      { id: 'a1', role: 'assistant', content: 'Finished overnight checks.' },
    ],
  });
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
    const kinds = ndjsonEvents(streamed.body).map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, ['run_start', 'message_update', 'run_end']);
    const runEnd = ndjsonEvents(streamed.body).find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'completed');

    // Transcript is NOT mirrored locally — it renders from Partner /messages.
    const legacyCount = db.prepare('SELECT COUNT(*) c FROM assistant_session_messages WHERE session_id = ?').get(sessionId) as any;
    assert.equal(legacyCount.c, 0, 'live turns no longer write legacy messages');
    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.deepEqual(detail.json().messages.map((m: any) => [m.role, m.content]), [
      ['user', 'Run checks tonight'],
      ['assistant', 'Finished overnight checks.'],
    ]);

    const run = db.prepare('SELECT status, output FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.deepEqual(run, { status: 'succeeded', output: 'Finished overnight checks.' });
  } finally {
    await cleanup(app, db, dir);
  }
});

test('streamSessionTurn maps /chat/stream tool SSE to structured NDJSON events', async () => {
  const fetchImpl = partnerChatMock({
    frames: [
      'event: assistant.delta\ndata: {"delta":"Reading."}\n\n',
      'event: tool.started\ndata: {"tool_name":"read_file","args":{"path":"/tmp/x"}}\n\n',
      'event: tool.completed\ndata: {"tool_name":"read_file","preview":"hi"}\n\n',
      'event: assistant.delta\ndata: {"delta":" Done."}\n\n',
      'event: run.completed\ndata: {}\n\n',
      'event: done\ndata: {}\n\n',
    ],
    messages: toolTurnMessages('read the file', 'Reading. Done.'),
  });
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
    assert.deepEqual(toolStart.args, { path: '/tmp/x' });
    const toolEnd = events.find((e) => e.type === 'tool_execution_end');
    assert.equal(toolEnd.toolCallId, toolStart.toolCallId, 'FIFO synthetic id correlates start→end');
    assert.equal(toolEnd.result.content[0].text, 'hi');
    assert.equal(events.find((e) => e.kind === 'run_end').run.status, 'completed');

    // On reload, the authoritative fold comes from /messages: the tool output is
    // inlined into the assistant message's tool_calls, never a raw bubble.
    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    const assistantMsg = detail.json().messages.find((m: any) => m.role === 'assistant');
    assert.equal(assistantMsg.content, 'Reading. Done.');
    assert.equal(assistantMsg.tool_calls[0].name, 'read_file');
    assert.equal(assistantMsg.tool_calls[0].result, 'hi');
    assert.ok(!detail.json().messages.some((m: any) => m.role === 'tool' || m.role === 'toolResult'));
  } finally {
    await cleanup(app, db, dir);
  }
});

test('foreground send hits the session-scoped /chat/stream endpoint (not /v1/responses)', async () => {
  const calls: string[] = [];
  const fetchImpl = partnerChatMock({
    frames: ['event: assistant.delta\ndata: {"delta":"ok"}\n\n', 'event: done\ndata: {}\n\n'],
    onOther: (url) => { calls.push(url); return undefined; },
  });
  const wrapped: PartnerFetch = async (url, init) => { calls.push(String(url)); return fetchImpl(url, init); };
  const { app, db, dir } = makeApp({ fetchImpl: wrapped });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;
    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'read it' } });

    assert.ok(calls.some((u) => /\/api\/sessions\/[^/]+\/chat\/stream$/.test(u)), 'used session-scoped chat/stream');
    assert.ok(!calls.some((u) => u.endsWith('/v1/responses')), 'did not use /v1/responses');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('streamSessionTurn emits error event when /chat/stream yields an error event mid-stream', async () => {
  const fetchImpl = partnerChatMock({
    frames: [
      'event: assistant.delta\ndata: {"delta":"Starting work."}\n\n',
      'event: error\ndata: {"message":"API rate limit exceeded"}\n\n',
      'event: done\ndata: {}\n\n',
    ],
  });
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

test('streamSessionTurn marks the run failed when the /chat/stream body throws mid-stream', async () => {
  // A body that emits a valid frame then ERRORS the stream — surfaces as a thrown
  // (non-abort) error out of partner.sessionChatStream.
  const fetchImpl = partnerChatMock({
    onChatStream: () => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('event: assistant.delta\ndata: {"delta":"partial"}\n\n'));
          controller.error(new Error('boom'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Throw test' } });
    const sessionId = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'do work that explodes' },
    });
    assert.equal(res.statusCode, 200);
    const events = ndjsonEvents(res.payload);
    assert.equal(events.find((e) => e.kind === 'run_end').run.status, 'failed');
    assert.ok(events.some((e) => e.type === 'error'), 'an error event is streamed');

    const run = db.prepare('SELECT status FROM assistant_runs WHERE session_id = ?').get(sessionId) as any;
    assert.equal(run.status, 'failed');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant detached run sync reconciles completed Partner output after restart', async () => {
  const fetchImpl = partnerChatMock({
    // The run agent persists the turn to Partner SessionDB; history renders from /messages.
    messages: [
      { id: 'u1', role: 'user', content: 'Work while Nexus is closed' },
      { id: 'a1', role: 'assistant', content: 'The overnight run is complete.' },
    ],
    onOther: (url, init) => {
      if (url.endsWith('/v1/runs') && init?.method === 'POST') return jsonRes({ run_id: 'remote-run-2', status: 'started' });
      if (url.endsWith('/v1/runs/remote-run-2')) return jsonRes({ run_id: 'remote-run-2', status: 'completed', output: 'The overnight run is complete.' });
      return undefined;
    },
  });
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

    const legacyCount = db.prepare('SELECT COUNT(*) c FROM assistant_session_messages WHERE session_id = ?').get(sessionId) as any;
    assert.equal(legacyCount.c, 0, 'no legacy-table writes');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground and background turns compose in one Partner transcript', async () => {
  const fetchImpl = partnerChatMock({
    frames: [
      'event: assistant.delta\ndata: {"delta":"Hi there."}\n\n',
      'event: run.completed\ndata: {}\n\n',
      'event: done\ndata: {}\n\n',
    ],
    // Both the foreground and the background turn live in the same Partner session.
    messages: [
      { id: 'u1', role: 'user', content: 'Hello' },
      { id: 'a1', role: 'assistant', content: 'Hi there.' },
      { id: 'u2', role: 'user', content: 'Work while Nexus is closed' },
      { id: 'a2', role: 'assistant', content: 'The background run is complete.' },
    ],
    onOther: (url, init) => {
      if (url.endsWith('/v1/runs') && init?.method === 'POST') return jsonRes({ run_id: 'remote-run-bg', status: 'started' });
      if (url.endsWith('/v1/runs/remote-run-bg')) return jsonRes({ run_id: 'remote-run-bg', status: 'completed', output: 'The background run is complete.' });
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Mixed fg/bg' } });
    const sessionId = created.json().id;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'Hello' },
    });
    assert.equal(streamed.statusCode, 200);

    const detached = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/runs`,
      payload: { content: 'Work while Nexus is closed' },
    });
    assert.equal(detached.statusCode, 200);

    const sync = await app.inject({ method: 'POST', url: '/api/assistant/sync' });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().updated, 1);

    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.deepEqual(detail.json().messages.map((message: any) => [message.role, message.content]), [
      ['user', 'Hello'],
      ['assistant', 'Hi there.'],
      ['user', 'Work while Nexus is closed'],
      ['assistant', 'The background run is complete.'],
    ]);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant runs persist attachments and send Partner saved file references', async () => {
  let partnerMessage = '';
  const fetchImpl = partnerChatMock({
    onChatStream: (_url, init) => {
      partnerMessage = JSON.parse(String(init?.body)).message;
      return sseResponse([
        'event: assistant.delta\ndata: {"delta":"Read the attached brief."}\n\n',
        'event: done\ndata: {}\n\n',
      ]);
    },
  });
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
    // The saved-file reference is threaded into the /chat/stream `message` field.
    assert.match(partnerMessage, /^Summarise this\n\nAttached files:\n- brief\.txt: /);
    assert.match(partnerMessage, /project_docs\/uploads\/brief\.txt/);

    const savedPath = join(dir, 'project_docs', 'uploads', 'brief.txt');
    assert.equal(existsSync(savedPath), true, 'attachment file saved to disk');
    assert.equal(readFileSync(savedPath, 'utf8'), 'hello from file');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Idea dialogue attachments are gated on a valid target repo and filed per idea', async () => {
  let partnerMessage = '';
  const fetchImpl = partnerChatMock({
    onChatStream: (_url, init) => {
      partnerMessage = JSON.parse(String(init?.body)).message;
      return sseResponse([
        'event: assistant.delta\ndata: {"delta":"Got the file."}\n\n',
        'event: done\ndata: {}\n\n',
      ]);
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO assistant_sessions (id, title, status, origin, created_at, updated_at) VALUES ('idea-sess', 'Idea: X', 'idle', 'idea', ?, ?)",
    ).run(now, now);
    db.prepare(
      `INSERT INTO ideas (id, title, seed, state, tags, session_id, source, created_at, updated_at)
       VALUES ('idea-1', 'X', '', 'discussing', '[]', 'idea-sess', 'idea_watcher', ?, ?)`,
    ).run(now, now);

    const attachment = {
      type: 'file',
      name: 'shot.txt',
      mimeType: 'text/plain',
      data: Buffer.from('evidence').toString('base64'),
      size: 8,
    };

    // No target repo yet → the upload is refused before anything hits disk,
    // for the web composer and iOS alike (server-side gate).
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/idea-sess/messages/stream',
      payload: { content: 'see attached', attachments: [attachment] },
    });
    assert.equal(blocked.statusCode, 400);
    assert.match(blocked.json().error, /target repo/);
    assert.equal(existsSync(join(dir, 'project_docs', 'uploads', 'ideas')), false, 'nothing saved while gated');

    // An invalid repo string is still gated; a valid owner/repo opens it.
    db.prepare("UPDATE ideas SET target_repo = 'not a repo' WHERE id = 'idea-1'").run();
    const stillBlocked = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/idea-sess/messages/stream',
      payload: { content: 'see attached', attachments: [attachment] },
    });
    assert.equal(stillBlocked.statusCode, 400);

    db.prepare("UPDATE ideas SET target_repo = 'k-sym/nexus' WHERE id = 'idea-1'").run();
    const streamed = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/idea-sess/messages/stream',
      payload: { content: 'see attached', attachments: [attachment] },
    });
    assert.equal(streamed.statusCode, 200);
    // Filed under the per-idea directory (so graduation can move it), and the
    // reference threaded into the prompt points there.
    const savedPath = join(dir, 'project_docs', 'uploads', 'ideas', 'idea-1', 'shot.txt');
    assert.equal(existsSync(savedPath), true, 'attachment filed under ideas/<id>/');
    assert.match(partnerMessage, /ideas\/idea-1\/shot\.txt/);

    // Text-only turns are never gated — the repo requirement is upload-only.
    const textOnly = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/idea-sess/messages/stream',
      payload: { content: 'just talking' },
    });
    assert.equal(textOnly.statusCode, 200);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground stream sends image attachments to Partner as inline data images', async () => {
  let createdRemoteSession = '';
  let partnerChatBody: any = null;
  const imageData = Buffer.from('fake-png').toString('base64');
  const fetchImpl: PartnerFetch = async (url, init) => {
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
      partnerChatBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        object: 'hermes.session.chat.completion',
        session_id: createdRemoteSession,
        message: { role: 'assistant', content: 'I can see the screenshot.' },
        usage: { total_tokens: 25 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Partner request ${requestUrl}`);
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
    assert.ok(Array.isArray(partnerChatBody.input));
    assert.deepEqual(partnerChatBody.input[0], { type: 'text', text: 'What do you see?' });
    assert.deepEqual(partnerChatBody.input[1], {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imageData}`, detail: 'high' },
    });
    assert.equal(JSON.stringify(partnerChatBody.input).includes('project_docs/uploads'), false);

    const events = ndjsonEvents(streamed.body);
    const kinds = events.map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, ['run_start', 'message_update', 'run_end']);
    const textDelta = events.find((e) => e.type === 'message_update');
    assert.equal(textDelta.assistantMessageEvent.type, 'text_delta');
    assert.equal(textDelta.assistantMessageEvent.delta, 'I can see the screenshot.');
    const runEnd = events.find((e) => e.kind === 'run_end');
    assert.equal(runEnd.run.status, 'completed');

    // The image attachment is saved to disk at the expected path regardless of message persistence.
    const savedPath = join(dir, 'project_docs', 'uploads', 'screen.png');
    assert.equal(existsSync(savedPath), true, 'image attachment file saved to disk');
    assert.equal(readFileSync(savedPath).toString('base64'), imageData);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground vision turn persists to the Partner session and renders from /messages', async () => {
  const imageData = Buffer.from('fake-png').toString('base64');
  const fetchImpl = partnerChatMock({
    // The vision turn goes through the session-scoped /chat endpoint, which persists
    // to Partner SessionDB; history then renders from /messages.
    messages: [
      { id: 'u1', role: 'user', content: 'What do you see?' },
      { id: 'a1', role: 'assistant', content: 'I can see the screenshot.' },
    ],
    onOther: (url, init) => {
      if (/\/api\/sessions\/[^/]+\/chat$/.test(url) && init?.method === 'POST') {
        return jsonRes({
          session_id: url.split('/').slice(-2)[0],
          message: { role: 'assistant', content: 'I can see the screenshot.' },
          usage: { total_tokens: 25 },
        });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Vision persistence' } });
    const sessionId = created.json().id;

    const streamed = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: {
        content: 'What do you see?',
        attachments: [{ type: 'image', name: 'screen.png', mimeType: 'image/png', data: imageData, size: 8 }],
      },
    });

    assert.equal(streamed.statusCode, 200);
    const kinds = ndjsonEvents(streamed.body).map((e) => e.kind ?? e.type);
    assert.deepEqual(kinds, ['run_start', 'message_update', 'run_end']);

    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.deepEqual(detail.json().messages.map((m: any) => [m.role, m.content]), [
      ['user', 'What do you see?'],
      ['assistant', 'I can see the screenshot.'],
    ]);

    const legacyCount = db.prepare('SELECT COUNT(*) c FROM assistant_session_messages WHERE session_id = ?').get(sessionId) as any;
    assert.equal(legacyCount.c, 0, 'vision turns do not write legacy messages either');
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

// The Partner assistant-api has no /v1/runs (capabilities: run_submission=false,
// verified live 2026-09-15). The run routes ask before they write anything.
test('Background handoff is refused with a clear 400 when the adapter does not advertise run_submission', async () => {
  const requested: string[] = [];
  const fetchImpl = partnerChatMock({
    capabilities: { run_submission: false, run_stop: false },
    onOther: (url) => { requested.push(url); return undefined; },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Partner' } });
    const sessionId = created.json().id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/runs`,
      payload: { content: 'Work while Nexus is closed' },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /Background Handoff is not available/);
    assert.ok(!requested.some((u) => u.includes('/v1/runs')), 'never calls /v1/runs');
    const rows = db.prepare('SELECT COUNT(*) AS count FROM assistant_runs WHERE session_id = ?').get(sessionId) as { count: number };
    assert.equal(rows.count, 0, 'no local run row for a refused handoff');
    assert.equal(db.prepare('SELECT status FROM assistant_sessions WHERE id = ?').get(sessionId)!.status, 'idle');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Session detail reports capabilities.backgroundHandoff from /v1/capabilities and caches the answer', async () => {
  let capabilityCalls = 0;
  const fetchImpl: PartnerFetch = async (url, init) => {
    if (String(url).endsWith('/v1/capabilities')) { capabilityCalls += 1; return capabilitiesRes({ run_submission: true, run_stop: true }); }
    return partnerChatMock({})(url, init);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Caps' } });
    const sessionId = created.json().id;
    const first = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().capabilities, { backgroundHandoff: true });
    const second = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.deepEqual(second.json().capabilities, { backgroundHandoff: true });
    assert.equal(capabilityCalls, 1, 'one capabilities fetch per configured URL');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Session detail hides background handoff for the Partner, an unreadable capabilities document, and no assistant', async () => {
  const partner = makeApp({ fetchImpl: partnerChatMock({ capabilities: { run_submission: false } }) });
  try {
    const created = await partner.app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Partner' } });
    const detail = await partner.app.inject({ method: 'GET', url: `/api/assistant/sessions/${created.json().id}` });
    assert.deepEqual(detail.json().capabilities, { backgroundHandoff: false });
  } finally {
    await cleanup(partner.app, partner.db, partner.dir);
  }

  // Fail closed: a 500 on /v1/capabilities must not break the detail route.
  const broken = makeApp({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/capabilities')) return new Response('boom', { status: 500 });
      return partnerChatMock({})(url, init);
    },
  });
  try {
    const created = await broken.app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Broken' } });
    const detail = await broken.app.inject({ method: 'GET', url: `/api/assistant/sessions/${created.json().id}` });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().capabilities, { backgroundHandoff: false });
  } finally {
    await cleanup(broken.app, broken.db, broken.dir);
  }

  const unconfigured = makeApp({ config: { ...loadConfig(), assistant: { url: '', api_key: '' } } });
  try {
    const created = await unconfigured.app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Local' } });
    const detail = await unconfigured.app.inject({ method: 'GET', url: `/api/assistant/sessions/${created.json().id}` });
    assert.deepEqual(detail.json().capabilities, { backgroundHandoff: false });
    const current = await unconfigured.app.inject({ method: 'GET', url: '/api/assistant/current' });
    assert.deepEqual(current.json().capabilities, { backgroundHandoff: false });
  } finally {
    await cleanup(unconfigured.app, unconfigured.db, unconfigured.dir);
  }
});

test('Sync settles stale running rows as unknown, and stop is refused, when the adapter cannot run background runs', async () => {
  const requested: string[] = [];
  const fetchImpl = partnerChatMock({
    capabilities: { run_submission: false, run_stop: false },
    onOther: (url) => { requested.push(url); return undefined; },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Stale' } });
    const sessionId = created.json().id;
    // A Hermes-era row left behind with a remote id the Partner cannot resolve.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO assistant_runs (id, session_id, remote_run_id, kind, status, input, output, started_at, updated_at)
       VALUES ('stale-run', ?, 'remote-stale', 'overnight', 'running', 'old work', '', ?, ?)`,
    ).run(sessionId, now, now);

    db.prepare("UPDATE assistant_sessions SET status = 'running', last_run_id = 'stale-run' WHERE id = ?").run(sessionId);

    const stop = await app.inject({ method: 'POST', url: '/api/assistant/runs/stale-run/stop' });
    assert.equal(stop.statusCode, 400);
    assert.match(stop.json().error, /Stopping a background run is not available/);
    assert.equal(db.prepare('SELECT status FROM assistant_runs WHERE id = ?').get('stale-run')!.status, 'running', 'no optimistic cancelling');

    // Nothing will ever finish the row against this adapter, so sync settles it
    // once: the session stops reading as running and clients stop polling.
    const sync = await app.inject({ method: 'POST', url: '/api/assistant/sync' });
    assert.equal(sync.statusCode, 200);
    assert.deepEqual(sync.json(), { updated: 1 });
    const settled = db.prepare('SELECT status, error FROM assistant_runs WHERE id = ?').get('stale-run') as any;
    assert.equal(settled.status, 'unknown');
    assert.match(settled.error, /does not support background runs/);
    assert.equal((db.prepare('SELECT status FROM assistant_sessions WHERE id = ?').get(sessionId) as any).status, 'unknown');
    const again = await app.inject({ method: 'POST', url: '/api/assistant/sync' });
    assert.deepEqual(again.json(), { updated: 0 }, 'a settled row is not touched again');
    assert.ok(!requested.some((u) => u.includes('/v1/runs')), 'never calls /v1/runs');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Sync leaves running rows alone while the capabilities document is unreadable', async () => {
  // Fail-closed hides handoff, but a blip must not settle the ledger: the row is
  // reconciled on a later sync once the adapter answers again.
  const base = partnerChatMock({});
  const fetchImpl: PartnerFetch = async (url, init) =>
    String(url).endsWith('/v1/capabilities') ? new Response('down', { status: 503 }) : base(url, init);
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'Blip' } });
    const sessionId = created.json().id;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO assistant_runs (id, session_id, remote_run_id, kind, status, input, output, started_at, updated_at)
       VALUES ('live-run', ?, 'remote-live', 'overnight', 'running', 'work', '', ?, ?)`,
    ).run(sessionId, now, now);

    const sync = await app.inject({ method: 'POST', url: '/api/assistant/sync' });
    assert.deepEqual(sync.json(), { updated: 0 });
    assert.equal(db.prepare('SELECT status FROM assistant_runs WHERE id = ?').get('live-run')!.status, 'running');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant sync isolates stale Hermes run_not_found failures and continues other runs', async () => {
  const fetchImpl = partnerChatMock({
    messages: [
      { id: 'u1', role: 'user', content: 'current work' },
      { id: 'a1', role: 'assistant', content: 'Current run completed.' },
    ],
    onOther: (url, init) => {
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        const runId = JSON.parse(String(init?.body)).input === 'stale work' ? 'remote-stale' : 'remote-current';
        return jsonRes({ run_id: runId, status: 'started' });
      }
      if (url.endsWith('/v1/runs/remote-stale')) {
        return new Response(JSON.stringify({
          error: { message: 'Run not found: remote-stale', type: 'invalid_request_error', code: 'run_not_found' },
        }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/v1/runs/remote-current')) {
        return jsonRes({ run_id: 'remote-current', status: 'completed', output: 'Current run completed.' });
      }
      return undefined;
    },
  });
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

test('deleting an Assistant session best-effort stops its running Partner runs without blocking delete', async () => {
  let stopCalls = 0;
  let deleteCalls = 0;
  const fetchImpl: PartnerFetch = async (url, init) => {
    if (String(url).endsWith('/api/sessions') && init?.method === 'POST') {
      // ensureRemoteSession before the background handoff.
      return new Response(JSON.stringify({ session: { id: JSON.parse(String(init.body)).id } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/capabilities')) return capabilitiesRes();
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'remote-delete-running', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-delete-running/stop')) {
      stopCalls += 1;
      return new Response('Partner stop failed', { status: 500 });
    }
    if (String(url).includes('/api/sessions/') && init?.method === 'DELETE') {
      deleteCalls += 1;
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Partner request ${String(url)}`);
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

test('POST /api/assistant/abort tears down the in-flight /chat/stream and finalizes the run as cancelled', async () => {
  const fetchImpl = partnerChatMock({
    onChatStream: (_url, init) => abortAwareSseResponse([
      'event: tool.started\ndata: {"tool_name":"read_file","args":{"path":"/tmp/x"}}\n\n',
    ], init?.signal ?? undefined),
  });
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

test('Assistant session list fetches remote api_server, tui, and cli sources and merges them', async () => {
  // The api_server /api/sessions endpoint filters one source per request and
  // returns epoch timestamps with occasionally-null titles; the route issues one
  // query per adoptable source and maps the rows onto the rail.
  const requestedSources: string[] = [];
  const rowsBySource: Record<string, any[]> = {
    api_server: [
      { id: 'remote-api-1', title: 'Remote API session', source: 'api_server', started_at: 1784120000, last_active: 1784120000 },
    ],
    tui: [
      // null title exercises the preview fallback; newest last_active sorts first
      { id: 'remote-tui-1', title: null, source: 'tui', preview: 'How do I clear sessions??', started_at: 1784125000, last_active: 1784126000 },
    ],
    cli: [
      { id: 'remote-cli-1', title: 'Remote CLI session', source: 'cli', started_at: 1784123000, last_active: 1784123500 },
    ],
  };
  const fetchImpl: PartnerFetch = async (url) => {
    const parsed = new URL(String(url), 'http://partner.local');
    if (parsed.pathname === '/api/sessions') {
      const source = parsed.searchParams.get('source') ?? '';
      // The widened filter must never fall back to a cron-flooding bare query.
      assert.notEqual(source, '');
      requestedSources.push(source);
      return new Response(JSON.stringify({ object: 'list', data: rowsBySource[source] ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected Partner request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.equal(list.statusCode, 200);

    // Exactly one query per adoptable source, and none for cron.
    assert.deepEqual([...requestedSources].sort(), ['api_server', 'cli', 'tui']);

    // Merged newest-first by last_active; null title falls back to preview.
    assert.deepEqual(list.json().sessions.map((session: any) => ({
      id: session.id,
      title: session.title,
      remoteOnly: session.remoteOnly,
      remote_session_id: session.remote_session_id,
      source: session.source,
    })), [
      {
        id: 'remote:remote-tui-1',
        title: 'How do I clear sessions??',
        remoteOnly: true,
        remote_session_id: 'remote-tui-1',
        source: 'tui',
      },
      {
        id: 'remote:remote-cli-1',
        title: 'Remote CLI session',
        remoteOnly: true,
        remote_session_id: 'remote-cli-1',
        source: 'cli',
      },
      {
        id: 'remote:remote-api-1',
        title: 'Remote API session',
        remoteOnly: true,
        remote_session_id: 'remote-api-1',
        source: 'api_server',
      },
    ]);

    // Epoch timestamps become ISO strings the rail can sort/render.
    const tui = list.json().sessions.find((s: any) => s.source === 'tui');
    assert.equal(tui.updated_at, new Date(1784126000 * 1000).toISOString());
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant session list merges remote sessions that already have local rows', async () => {
  const fetchImpl: PartnerFetch = async (url) => {
    if (String(url).includes('/api/sessions?')) {
      return new Response(JSON.stringify({
        sessions: [{ id: 'remote-api-1', title: 'Remote title', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Partner request ${String(url)}`);
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

test('Assistant import route adopts a remote Partner session and renders its transcript', async () => {
  const fetchImpl = partnerChatMock({
    messages: [
      { id: 'hm1', role: 'user', content: 'continue this' },
      { id: 'hm2', role: 'assistant', content: 'I can continue.' },
    ],
    onOther: (url) => {
      if (url.endsWith('/api/sessions/remote-api-1')) {
        return jsonRes({ session: { id: 'remote-api-1', title: 'Remote API session', source: 'api_server' } });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const imported = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/import',
      payload: { remoteSessionId: 'remote-api-1' },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().session.remote_session_id, 'remote-api-1');
    // Adoption is a pointer at the remote session; the transcript renders live from /messages.
    assert.deepEqual(imported.json().messages.map((message: any) => [message.role, message.content]), [
      ['user', 'continue this'],
      ['assistant', 'I can continue.'],
    ]);

    // Re-import is idempotent — it re-points and re-renders the same transcript.
    const again = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/import',
      payload: { remoteSessionId: 'remote-api-1' },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().session.id, imported.json().session.id);
    assert.deepEqual(again.json().messages.map((m: any) => [m.role, m.content]), [
      ['user', 'continue this'],
      ['assistant', 'I can continue.'],
    ]);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant import folds tool output into the assistant message (never a raw bubble)', async () => {
  const fetchImpl = partnerChatMock({
    // Partner JSON-parses the tool_calls column before returning it, and emits
    // tool output as a standalone `role:'tool'` row with tool_call_id/tool_name.
    messages: [
      { id: 'hm1', role: 'user', content: 'run the check' },
      {
        id: 'hm2',
        role: 'assistant',
        content: 'On it.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'terminal', arguments: '{"command":"uptime"}' } }],
      },
      { id: 'hm3', role: 'tool', tool_call_id: 'toolu_1', tool_name: 'terminal', content: 'load average: 0.4' },
    ],
    onOther: (url) => {
      if (url.endsWith('/api/sessions/remote-tool-1')) return jsonRes({ session: { id: 'remote-tool-1', title: 'Health check', source: 'tui' } });
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const imported = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/import',
      payload: { remoteSessionId: 'remote-tool-1' },
    });
    assert.equal(imported.statusCode, 200);

    const messages = imported.json().messages as any[];
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    assert.equal(assistantMsg.content, 'On it.');
    assert.equal(assistantMsg.tool_calls?.length, 1, 'assistant carries the tool call');
    assert.equal(assistantMsg.tool_calls[0].name, 'terminal');
    assert.deepEqual(assistantMsg.tool_calls[0].args, { command: 'uptime' });
    // Paired with its result (folded output), not a raw bubble.
    assert.equal(assistantMsg.tool_calls[0].result, 'load average: 0.4');
    assert.equal(assistantMsg.tool_calls[0].status, 'succeeded');
    assert.ok(!messages.some((m) => m.content.includes('load average')), 'tool output is never a message body');
    assert.ok(!messages.some((m) => m.role === 'tool' || m.role === 'toolResult'), 'no standalone tool rows');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant foreground send runs against the adopted remote Partner session', async () => {
  // The foreground turn streams over the session-scoped /chat/stream endpoint;
  // assert the request targets the adopted remote session id, not the local row id.
  let chatStreamUrl = '';
  const fetchImpl = partnerChatMock({
    onChatStream: (url) => {
      chatStreamUrl = url;
      return sseResponse(['event: assistant.delta\ndata: {"delta":"resumed"}\n\n', 'event: done\ndata: {}\n\n']);
    },
  });
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
    assert.match(chatStreamUrl, /\/api\/sessions\/remote-api-1\/chat\/stream$/);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('foreground turns run against the same Partner session for native continuity', async () => {
  // Continuity is handled by Partner (the session loads its own history), so every
  // turn targets the same session-scoped /chat/stream — no previous_response_id.
  const streamUrls: string[] = [];
  const fetchImpl = partnerChatMock({
    onChatStream: (url) => {
      streamUrls.push(url);
      return sseResponse(['event: assistant.delta\ndata: {"delta":"ok"}\n\n', 'event: done\ndata: {}\n\n']);
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;

    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'turn 1' } });
    await app.inject({ method: 'POST', url: `/api/assistant/sessions/${sessionId}/messages/stream`, payload: { content: 'turn 2' } });

    assert.equal(streamUrls.length, 2);
    assert.equal(streamUrls[0], streamUrls[1], 'both turns hit the same session-scoped endpoint');
    assert.match(streamUrls[0], new RegExp(`/api/sessions/${sessionId}/chat/stream$`));
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant stream passes modelKey to the adapter and relays context_usage (#75)', async () => {
  let streamBody: any = null;
  const fetchImpl = partnerChatMock({
    onChatStream: (_url, init) => {
      streamBody = JSON.parse(String(init?.body ?? '{}'));
      return sseResponse([
        'event: run.started\ndata: {"session_id":"s1","model":"opus"}\n\n',
        'event: assistant.delta\ndata: {"delta":"hey"}\n\n',
        'event: run.completed\ndata: {"model":"opus","usage":{"input_tokens":10,"cache_read_input_tokens":49990},"context":{"used":50000,"limit":200000,"model":"opus"}}\n\n',
        'event: done\ndata: {}\n\n',
      ]);
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: { title: 'T' } });
    const sessionId = created.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'hi', modelKey: 'partner/opus' },
    });
    assert.equal(res.statusCode, 200);
    // The iOS `provider/id` key arrives at the adapter as the bare alias.
    assert.equal(streamBody.model, 'opus');
    const events = ndjsonEvents(res.body);
    const runStart = events.find((e) => e.kind === 'run_start');
    assert.equal(runStart.run.model, 'opus');
    const usage = events.find((e) => e.type === 'context_usage');
    assert.deepEqual(usage.usage, { tokens: 50000, contextWindow: 200000, percent: 25 });
    // usage lands on the run row too
    const run = db.prepare('SELECT usage_json FROM assistant_runs ORDER BY started_at DESC LIMIT 1').get() as any;
    assert.deepEqual(JSON.parse(run.usage_json), { input_tokens: 10, cache_read_input_tokens: 49990 });
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant stream without modelKey stays off the wire and emits no context_usage on bare completions', async () => {
  let streamBody: any = null;
  const fetchImpl = partnerChatMock({
    onChatStream: (_url, init) => {
      streamBody = JSON.parse(String(init?.body ?? '{}'));
      return sseResponse(['event: run.completed\ndata: {}\n\n', 'event: done\ndata: {}\n\n']);
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: {} });
    const sessionId = created.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'hi' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal('model' in streamBody, false);
    const events = ndjsonEvents(res.body);
    assert.equal(events.find((e) => e.type === 'context_usage'), undefined);
    assert.equal(events.find((e) => e.kind === 'run_start').run.model, 'partner');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('GET /api/assistant/models proxies the adapter catalog into the /api/models shape (#75)', async () => {
  const fetchImpl = partnerChatMock({
    onOther: (url) => {
      if (String(url).endsWith('/v1/models')) {
        return jsonRes({
          models: [
            { id: 'sonnet', label: 'Sonnet', context_limit: 200000, default: true },
            { id: 'opus', label: 'Opus', context_limit: 200000, default: false },
            { id: 'haiku', label: 'Haiku', context_limit: 200000, default: false },
          ],
          default: 'sonnet',
        });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/assistant/models' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.default, 'partner/sonnet');
    assert.deepEqual(body.models[0], {
      provider: 'partner',
      id: 'sonnet',
      name: 'Sonnet',
      contextWindow: 200000,
      configured: true,
      default: true,
    });
    assert.equal(body.models.length, 3);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('GET /api/assistant/models fails soft to an empty list', async () => {
  // partnerChatMock throws on /v1/models by default (unexpected request).
  const { app, db, dir } = makeApp({ fetchImpl: partnerChatMock({}) });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/assistant/models' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { models: [] });
  } finally {
    await cleanup(app, db, dir);
  }
});

test('Assistant session detail seeds lastModelKey + contextUsage from the adapter row (#75)', async () => {
  const fetchImpl = partnerChatMock({
    messages: [{ id: 1, role: 'user', content: 'hi' }],
    onOther: (url, init) => {
      if (/\/api\/sessions\/[^/]+$/.test(String(url)) && (!init?.method || init.method === 'GET')) {
        return jsonRes({
          session: {
            id: String(url).split('/').pop(),
            model: 'opus',
            context_used: 50000,
            context_limit: 200000,
          },
        });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/assistant/sessions', payload: {} });
    const sessionId = created.json().id;
    // First send establishes remote_session_id — the seed source.
    await app.inject({
      method: 'POST',
      url: `/api/assistant/sessions/${sessionId}/messages/stream`,
      payload: { content: 'hi' },
    });
    const detail = await app.inject({ method: 'GET', url: `/api/assistant/sessions/${sessionId}` });
    assert.equal(detail.statusCode, 200);
    const body = detail.json();
    assert.equal(body.lastModelKey, 'partner/opus');
    assert.deepEqual(body.contextUsage, { tokens: 50000, contextWindow: 200000, percent: 25 });
  } finally {
    await cleanup(app, db, dir);
  }
});

// -- the one-conversation model (baker-internal#114 / #381) ------------------

test('GET /api/assistant/current adopts the remote pointer session and re-finds it on repeat', async () => {
  const fetchImpl = partnerChatMock({
    messages: [{ id: 'm1', role: 'assistant', content: 'hello from the partner' }],
    onOther: (u, init) => {
      if (u.endsWith('/v1/current-session') && (!init?.method || init.method === 'GET')) {
        return jsonRes({ session: { id: 'partner-123-abc', title: 'Partner' } });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const first = await app.inject({ method: 'GET', url: '/api/assistant/current' });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as any;
    assert.equal(firstBody.session.remote_session_id, 'partner-123-abc');
    assert.equal(firstBody.session.title, 'Partner');
    assert.equal(firstBody.messages.at(-1)?.content, 'hello from the partner');

    // Same pointer again → the SAME local row, never a duplicate adoption.
    const second = await app.inject({ method: 'GET', url: '/api/assistant/current' });
    assert.equal(second.json().session.id, firstBody.session.id);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM assistant_sessions WHERE remote_session_id = ?')
      .get('partner-123-abc') as { n: number };
    assert.equal(rows.n, 1);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('POST /api/assistant/current/rotate adopts the fresh pointer session', async () => {
  const fetchImpl = partnerChatMock({
    messages: [],
    onOther: (u, init) => {
      if (u.endsWith('/v1/current-session/rotate') && init?.method === 'POST') {
        return jsonRes({ session: { id: 'partner-456-def', title: 'Partner' } });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/assistant/current/rotate' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().session.remote_session_id, 'partner-456-def');
  } finally {
    await cleanup(app, db, dir);
  }
});

test('GET /api/assistant/current falls back to a local session when no assistant is configured', async () => {
  const { app, db, dir } = makeApp({ config: { ...loadConfig(), assistant: { url: '', api_key: '' } } });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/assistant/current' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as any;
    assert.ok(body.session.id);
    assert.equal(body.session.remote_session_id ?? null, null);
  } finally {
    await cleanup(app, db, dir);
  }
});

test('GET /api/assistant/current surfaces adapter failure as 502, not a crash', async () => {
  const fetchImpl = partnerChatMock({
    onOther: (u) => {
      if (u.endsWith('/v1/current-session')) {
        return new Response('adapter down', { status: 503 });
      }
      return undefined;
    },
  });
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/assistant/current' });
    assert.equal(res.statusCode, 502);
    assert.match((res.json() as any).error, /current-session failed/);
  } finally {
    await cleanup(app, db, dir);
  }
});

// -- semantic session names (design D18, #477 slice 5) ----------------------

test('an untitled remote partner session is named for what it is, not which process holds it', () => {
  assert.equal(remoteSessionTitle({ title: '  Colchester refit  ' }), 'Colchester refit');
  assert.equal(remoteSessionTitle({ title: null, preview: 'Thursday works for me' }), 'Thursday works for me');
  assert.equal(remoteSessionTitle({ title: null, preview: '', source: 'tui' }), 'Partner conversation · TUI');
  assert.equal(remoteSessionTitle({ source: 'api_server' }), 'Partner conversation · API');
  assert.equal(remoteSessionTitle({}), 'Partner conversation');
});

