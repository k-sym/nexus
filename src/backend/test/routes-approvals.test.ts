import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ApprovalBroker,
  ATTENDED_APPROVAL_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from '../pi/approvals';
import { registerApprovalRoutes, toPendingDto, type ApprovalStreamEvent } from '../routes/approvals';

const INPUT = { command: 'docker compose up -d' };

async function buildApp(broker: ApprovalBroker): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('pi', { approvals: broker } as never);
  await app.register(registerApprovalRoutes);
  await app.ready();
  return app;
}

test('GET /api/approvals lists pending gates with their category', async () => {
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const gate = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');

    const res = await app.inject({ method: 'GET', url: '/api/approvals' });
    assert.equal(res.statusCode, 200);
    const { approvals } = res.json() as { approvals: Array<Record<string, unknown>> };
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, 'bash');
    assert.equal(approvals[0].category, 'exec', 'the UI gets the classification, not just a name');
    assert.equal(approvals[0].cwd, '/repo');
    assert.deepEqual(approvals[0].input, INPUT);

    broker.cancelThread('thread-1', 'cleanup');
    await gate;
  } finally {
    await app.close();
  }
});

test('POST decision allows a gate and 404s once it is gone', async () => {
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const gate = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');

    const ok = await app.inject({
      method: 'POST', url: '/api/approvals/call-1/decision', payload: { action: 'allow' },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(await gate, { block: false });

    // Same id again: the gate is resolved, so this is an honest 404 rather
    // than a silent no-op.
    const gone = await app.inject({
      method: 'POST', url: '/api/approvals/call-1/decision', payload: { action: 'allow' },
    });
    assert.equal(gone.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('POST decision denies with the supplied reason', async () => {
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const gate = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');
    const res = await app.inject({
      method: 'POST', url: '/api/approvals/call-1/decision', payload: { action: 'deny', reason: 'not on this repo' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await gate, { block: true, reason: 'not on this repo' });
  } finally {
    await app.close();
  }
});

test('an unknown action is treated as allow, never as an unhandled 500', async () => {
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const gate = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');
    const res = await app.inject({
      method: 'POST', url: '/api/approvals/call-1/decision', payload: { action: 'wat' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await gate, { block: false });
  } finally {
    await app.close();
  }
});

test('toPendingDto classifies an unknown tool rather than dropping the field', () => {
  const dto = toPendingDto({
    threadId: 't', toolCallId: 'c', toolName: 'docker_service',
    input: {}, cwd: '/repo', requestedAt: 1,
  });
  assert.equal(dto.category, 'unknown');
});

// ── presence-aware timeouts ───────────────────────────────────────────────────

test('gates wait longer while an interactive client is attached', () => {
  const broker = new ApprovalBroker();
  assert.equal(broker.clientCount(), 0);

  const detach = broker.attachClient();
  assert.equal(broker.clientCount(), 1);
  detach();
  assert.equal(broker.clientCount(), 0);
  // Detaching twice must not drive the count negative and resurrect the
  // attended window for everyone else.
  detach();
  assert.equal(broker.clientCount(), 0);

  assert.ok(
    ATTENDED_APPROVAL_TIMEOUT_MS > DEFAULT_APPROVAL_TIMEOUT_MS,
    'the attended window is the longer one',
  );
});

test('a gate parked before the client attached is rescheduled onto the longer window', async () => {
  const broker = new ApprovalBroker();
  // 20ms unattended: without rescheduling this would default-deny almost
  // immediately. Attaching must re-arm it against ATTENDED_APPROVAL_TIMEOUT_MS.
  const gate = broker.register('t', 'c1', 'bash', INPUT, '/repo');
  const detach = broker.attachClient();

  const keepAlive = setTimeout(() => {}, 60);
  await new Promise((r) => setTimeout(r, 40));
  clearTimeout(keepAlive);

  assert.equal(broker.hasPending('t'), true, 'still waiting for a human');
  broker.decide('t', 'c1', 'allow');
  assert.deepEqual(await gate, { block: false });
  detach();
});

test('an explicitly-pinned timeout is never rescheduled underneath the caller', async () => {
  const broker = new ApprovalBroker();
  // Tests (and the glasses path) pin a timeout; attaching a UI client must not
  // silently extend it.
  const gate = broker.register('t', 'c1', 'bash', INPUT, '/repo', undefined, 15);
  const detach = broker.attachClient();

  const keepAlive = setTimeout(() => {}, 5_000);
  const decision = await gate;
  clearTimeout(keepAlive);

  assert.equal(decision.block, true);
  assert.match(decision.reason ?? '', /timed out/i);
  detach();
});

// ── the live stream ───────────────────────────────────────────────────────────

/** Read NDJSON frames off the stream until `count` events have arrived. */
async function readEvents(body: NodeJS.ReadableStream, count: number): Promise<ApprovalStreamEvent[]> {
  const events: ApprovalStreamEvent[] = [];
  let buffer = '';
  for await (const chunk of body) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue; // heartbeat
      events.push(JSON.parse(line) as ApprovalStreamEvent);
      if (events.length >= count) return events;
    }
  }
  return events;
}

test('the stream opens with a snapshot then pushes pending and resolved', async () => {
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const existing = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');

    const res = await app.inject({ method: 'GET', url: '/api/approvals/stream', payloadAsStream: true });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /x-ndjson/);

    const collecting = readEvents(res.stream(), 3);
    // Give the snapshot a tick to land before generating more events.
    await new Promise((r) => setTimeout(r, 10));
    const second = broker.register('thread-1', 'call-2', 'edit', { file_path: '/x.ts' }, '/repo');
    broker.decide('thread-1', 'call-2', 'deny', 'no');

    const events = await collecting;
    assert.equal(events[0].kind, 'snapshot');
    assert.equal(events[0].kind === 'snapshot' && events[0].approvals.length, 1);
    assert.equal(events[0].kind === 'snapshot' && events[0].approvals[0].toolCallId, 'call-1');

    assert.equal(events[1].kind, 'pending');
    assert.equal(events[1].kind === 'pending' && events[1].approval.toolCallId, 'call-2');
    assert.equal(events[1].kind === 'pending' && events[1].approval.category, 'write');

    assert.equal(events[2].kind, 'resolved');
    assert.equal(events[2].kind === 'resolved' && events[2].toolCallId, 'call-2');

    await second;
    broker.cancelThread('thread-1', 'cleanup');
    await existing;
  } finally {
    await app.close();
  }
});

test('an open stream counts as an attached client and releases on disconnect', async () => {
  // Deliberately a real listening server rather than app.inject: the thing
  // under test is socket teardown, and inject's in-memory request never emits
  // the 'close' that drives cleanup. A leaked client here would silently hold
  // every gate on the attended timeout forever, so it has to be exercised for
  // real to mean anything.
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    assert.equal(broker.clientCount(), 0);

    const controller = new AbortController();
    const res = await fetch(`${address}/api/approvals/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);

    // Read the snapshot frame so we know the handler has run to the point of
    // attaching, rather than racing it.
    const reader = res.body!.getReader();
    await reader.read();
    assert.equal(broker.clientCount(), 1, 'holding the stream open attaches a client');

    controller.abort();
    await waitFor(() => broker.clientCount() === 0);
    assert.equal(broker.clientCount(), 0, 'dropping the connection detaches');
  } finally {
    await app.close();
  }
});

/** Poll until `predicate` holds or the budget runs out. Socket teardown is
 *  asynchronous and not observable any other way from here. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('whoever decides first wins; the other surface sees it resolve', async () => {
  const broker = new ApprovalBroker();
  const app = await buildApp(broker);
  try {
    const gate = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');
    const res = await app.inject({ method: 'GET', url: '/api/approvals/stream', payloadAsStream: true });
    const collecting = readEvents(res.stream(), 2);
    await new Promise((r) => setTimeout(r, 10));

    // The "glasses" decide directly on the broker, not through these routes.
    assert.deepEqual(broker.decide('thread-1', 'call-1', 'allow'), { ok: true });
    assert.deepEqual(await gate, { block: false });

    // The in-app client is told, and its own attempt now 404s.
    const events = await collecting;
    assert.equal(events[1].kind, 'resolved');
    assert.equal(events[1].kind === 'resolved' && events[1].toolCallId, 'call-1');

    const late = await app.inject({
      method: 'POST', url: '/api/approvals/call-1/decision', payload: { action: 'deny' },
    });
    assert.equal(late.statusCode, 404, 'the loser gets a 404, not a second decision');

    res.stream().destroy();
  } finally {
    await app.close();
  }
});
