import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { QuestionBroker, type QuestionRequest } from '../pi/questions';
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
  const pi = { questions, readMessages: async () => [] } as unknown as import('../pi/runtime').PiRuntime;
  const handle = createGatewayApp({ pi, db, mainPort: 0, config: { enabled: true, port: 0, token, recentMs: 60_000 } });
  return {
    handle,
    questions,
    cleanup: async () => {
      await handle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
