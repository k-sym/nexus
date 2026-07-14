import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { QuestionBroker, type QuestionRequest } from '../pi/questions';
import { ApprovalBroker } from '../pi/approvals';
import { createGatewayApp } from '../gateway/server';

const REQUEST: QuestionRequest = {
  questions: [
    {
      id: 'q1',
      header: 'H',
      question: 'Pick one',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      multiple: false,
      allowOther: true,
    },
  ],
};

function setup(token = '') {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-gw-'));
  const db = getDb(join(dir, 'test.db'));
  const questions = new QuestionBroker();
  const approvals = new ApprovalBroker();
  const supervised = new Set<string>();
  const pi = {
    questions,
    approvals,
    readMessages: async () => [],
    setSupervised: (threadId: string, on: boolean) => {
      if (on) supervised.add(threadId);
      else { supervised.delete(threadId); approvals.cancelThread(threadId, 'Supervise disabled'); }
    },
    isSupervised: (threadId: string) => supervised.has(threadId),
    listSupervised: () => Array.from(supervised),
  } as unknown as import('../pi/runtime').PiRuntime;
  const handle = createGatewayApp({ pi, db, mainPort: 0, config: { enabled: true, port: 0, token, recentMs: 60_000 } });
  return {
    handle,
    questions,
    approvals,
    supervised,
    db,
    dir,
    cleanup: async () => {
      await handle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Seed a real chat thread so resolveSession() maps a session id → chat thread. */
function seedChatThread(db: ReturnType<typeof getDb>, threadId: string, repoPath: string): void {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('proj-1', 'proj', 'Proj', '', repoPath, '{}', 0, '', now, now);
  db.prepare('INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(threadId, 'proj-1', 'agent-1', 'Thread', now, now, null);
}

test('pending question surfaces as an approval and can be answered', async () => {
  const { handle, questions, cleanup } = setup();
  try {
    const pending = questions.register('t1', 'call1', REQUEST);

    const list = await handle.app.inject({ method: 'GET', url: '/api/approvals' });
    assert.equal(list.statusCode, 200);
    const approvals = list.json().approvals;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, 'call1');
    assert.equal(approvals[0].kind, 'question');
    assert.equal(approvals[0].session_id, 't1');

    const decide = await handle.app.inject({
      method: 'POST',
      url: '/api/approvals/call1/decision',
      payload: { action: 'answer', answers: { 'Pick one': 'Beta' } },
    });
    assert.equal(decide.statusCode, 200);
    assert.deepEqual(decide.json(), { ok: true });

    const result = await pending;
    assert.equal(result.status, 'answered');
    assert.deepEqual(result.status === 'answered' ? result.answers : null, [{ questionId: 'q1', selected: ['b'] }]);
  } finally {
    await cleanup();
  }
});

test('deny cancels a pending question', async () => {
  const { handle, questions, cleanup } = setup();
  try {
    const pending = questions.register('t2', 'call2', REQUEST);
    const res = await handle.app.inject({ method: 'POST', url: '/api/approvals/call2/decision', payload: { action: 'deny' } });
    assert.equal(res.statusCode, 200);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
  } finally {
    await cleanup();
  }
});

test('unknown approval id returns 404', async () => {
  const { handle, cleanup } = setup();
  try {
    const res = await handle.app.inject({ method: 'POST', url: '/api/approvals/nope/decision', payload: { action: 'answer', answers: {} } });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test('health is open but other routes require the token when configured', async () => {
  const { handle, cleanup } = setup('secret');
  try {
    const health = await handle.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().dev, false);

    const denied = await handle.app.inject({ method: 'GET', url: '/api/approvals' });
    assert.equal(denied.statusCode, 401);

    const okHeader = await handle.app.inject({ method: 'GET', url: '/api/approvals', headers: { authorization: 'Bearer secret' } });
    assert.equal(okHeader.statusCode, 200);

    const okQuery = await handle.app.inject({ method: 'GET', url: '/api/approvals?token=secret' });
    assert.equal(okQuery.statusCode, 200);
  } finally {
    await cleanup();
  }
});

test('pending tool-gate surfaces as a kind:approval and allow resolves {block:false}', async () => {
  const { handle, approvals, cleanup } = setup();
  try {
    const gate = approvals.register('t1', 'tool1', 'bash', { command: 'rm -rf build' }, '/repo');

    const list = await handle.app.inject({ method: 'GET', url: '/api/approvals' });
    assert.equal(list.statusCode, 200);
    const approval = list.json().approvals.find((a: { id: string }) => a.id === 'tool1');
    assert.ok(approval);
    assert.equal(approval.kind, 'approval');
    assert.equal(approval.session_id, 't1');
    assert.equal(approval.tool_name, 'bash');
    assert.equal(approval.cwd, '/repo');
    assert.deepEqual(approval.tool_input, { command: 'rm -rf build' });
    assert.match(approval.title, /rm -rf build/);

    const decide = await handle.app.inject({ method: 'POST', url: '/api/approvals/tool1/decision', payload: { action: 'allow' } });
    assert.equal(decide.statusCode, 200);
    assert.deepEqual(decide.json(), { ok: true });
    assert.deepEqual(await gate, { block: false });
  } finally {
    await cleanup();
  }
});

test('deny on a tool-gate resolves {block:true} with the reason', async () => {
  const { handle, approvals, cleanup } = setup();
  try {
    const gate = approvals.register('t1', 'tool2', 'edit', { file_path: '/x.ts' }, '/repo');
    const res = await handle.app.inject({ method: 'POST', url: '/api/approvals/tool2/decision', payload: { action: 'deny', reason: 'nope' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await gate, { block: true, reason: 'nope' });
  } finally {
    await cleanup();
  }
});

test('a decision with no action defaults a tool-gate to allow', async () => {
  const { handle, approvals, cleanup } = setup();
  try {
    const gate = approvals.register('t1', 'tool3', 'bash', { command: 'ls' }, '/repo');
    const res = await handle.app.inject({ method: 'POST', url: '/api/approvals/tool3/decision', payload: {} });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await gate, { block: false });
  } finally {
    await cleanup();
  }
});

test('questions and tool-gates share the approval queue without id collision', async () => {
  const { handle, questions, approvals, cleanup } = setup();
  try {
    const q = questions.register('t1', 'q1', REQUEST);
    const gate = approvals.register('t1', 'g1', 'bash', { command: 'ls' }, '/repo');

    const list = await handle.app.inject({ method: 'GET', url: '/api/approvals' });
    const kinds = list.json().approvals.map((a: { id: string; kind: string }) => `${a.id}:${a.kind}`).sort();
    assert.deepEqual(kinds, ['g1:approval', 'q1:question']);

    // A question decision still routes to the QuestionBroker.
    await handle.app.inject({ method: 'POST', url: '/api/approvals/q1/decision', payload: { action: 'answer', answers: { 'Pick one': 'Beta' } } });
    assert.equal((await q).status, 'answered');
    // A tool-gate decision routes to the ApprovalBroker.
    await handle.app.inject({ method: 'POST', url: '/api/approvals/g1/decision', payload: { action: 'allow' } });
    assert.deepEqual(await gate, { block: false });
  } finally {
    await cleanup();
  }
});

test('POST /api/supervise toggles a chat session and shows in /api/state', async () => {
  const { handle, supervised, db, cleanup } = setup();
  try {
    seedChatThread(db, 'thread-1', '/repo');

    const on = await handle.app.inject({ method: 'POST', url: '/api/supervise', payload: { session_id: 'thread-1', supervised: true } });
    assert.equal(on.statusCode, 200);
    assert.deepEqual(on.json(), { ok: true, session_id: 'thread-1', supervised: true });
    assert.equal(supervised.has('thread-1'), true);

    const state = await handle.app.inject({ method: 'GET', url: '/api/state' });
    assert.deepEqual(state.json().supervised, ['thread-1']);

    const off = await handle.app.inject({ method: 'POST', url: '/api/supervise', payload: { session_id: 'thread-1', supervised: false } });
    assert.equal(off.json().supervised, false);
    assert.equal(supervised.has('thread-1'), false);
  } finally {
    await cleanup();
  }
});

test('disabling supervise releases parked tool-gates (default-deny)', async () => {
  const { handle, approvals, db, cleanup } = setup();
  try {
    seedChatThread(db, 'thread-1', '/repo');
    await handle.app.inject({ method: 'POST', url: '/api/supervise', payload: { session_id: 'thread-1', supervised: true } });
    const gate = approvals.register('thread-1', 'g1', 'bash', { command: 'ls' }, '/repo');

    const off = await handle.app.inject({ method: 'POST', url: '/api/supervise', payload: { session_id: 'thread-1', supervised: false } });
    assert.equal(off.statusCode, 200);
    assert.deepEqual(await gate, { block: true, reason: 'Supervise disabled' });
  } finally {
    await cleanup();
  }
});

test('supervise rejects a missing or non-chat session', async () => {
  const { handle, cleanup } = setup();
  try {
    const noId = await handle.app.inject({ method: 'POST', url: '/api/supervise', payload: { supervised: true } });
    assert.equal(noId.statusCode, 400);
    const unknown = await handle.app.inject({ method: 'POST', url: '/api/supervise', payload: { session_id: 'ghost', supervised: true } });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test('a tool-gate pushes pending then resolved over SSE', async () => {
  const { handle, approvals, cleanup } = setup();
  try {
    const res = await handle.app.inject({ method: 'GET', url: '/api/events', payloadAsStream: true });
    const stream = res.stream();
    const frames: string[] = [];
    const collecting = new Promise<void>((resolve) => {
      let seen = 0;
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        frames.push(text);
        if (text.includes('"type":"pending"')) seen += 1;
        if (text.includes('"type":"resolved"')) seen += 1;
        if (seen >= 2) resolve();
      });
    });

    // Give the SSE hello a tick, then drive a gate through its lifecycle.
    await new Promise((r) => setTimeout(r, 20));
    const gate = approvals.register('t1', 'g1', 'bash', { command: 'ls' }, '/repo');
    approvals.decide('t1', 'g1', 'allow');
    await gate;
    await collecting;

    const joined = frames.join('');
    assert.match(joined, /"type":"pending".*"id":"g1".*"kind":"approval"/s);
    assert.match(joined, /"type":"resolved".*"id":"g1"/s);
    stream.destroy();
  } finally {
    await cleanup();
  }
});

test('steer to an unknown session 404s (no run triggered)', async () => {
  const { handle, cleanup } = setup();
  try {
    const res = await handle.app.inject({ method: 'POST', url: '/api/steer/anything', payload: { message: 'hi' } });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test('steer without a message is a 400', async () => {
  const { handle, cleanup } = setup();
  try {
    const res = await handle.app.inject({ method: 'POST', url: '/api/steer/anything', payload: {} });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup();
  }
});
