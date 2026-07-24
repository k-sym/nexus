import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalBroker,
  createApprovalExtension,
  UNGATED_TOOL_NAMES,
  type ApprovalBrokerEvent,
} from '../pi/approvals';
import { createToolPolicyResolver } from '../pi/tool-policy';

const INPUT = { command: 'rm -rf build' };

test('approval broker stays pending until allow resolves it to {block:false}', async () => {
  const broker = new ApprovalBroker();
  let settled = false;
  const pending = broker
    .register('thread-1', 'call-1', 'bash', INPUT, '/repo')
    .then((decision) => { settled = true; return decision; });
  await Promise.resolve();
  assert.equal(settled, false);

  // Wrong thread / wrong id are 404s and leave it pending.
  assert.deepEqual(broker.decide('thread-2', 'call-1', 'allow'), { ok: false, status: 404, error: 'Approval not found' });
  assert.deepEqual(broker.decide('thread-1', 'nope', 'allow'), { ok: false, status: 404, error: 'Approval not found' });
  await Promise.resolve();
  assert.equal(settled, false);

  assert.deepEqual(broker.decide('thread-1', 'call-1', 'allow'), { ok: true });
  assert.deepEqual(await pending, { block: false, answeredBy: 'human' });
  // Resolved once — a second decide is a 404.
  assert.equal(broker.decide('thread-1', 'call-1', 'allow').ok, false);
});

test('approval broker deny resolves to {block:true} with the reason', async () => {
  const broker = new ApprovalBroker();
  const pending = broker.register('t', 'a', 'bash', INPUT, '/repo');
  assert.deepEqual(broker.decide('t', 'a', 'deny', '  too risky  '), { ok: true });
  assert.deepEqual(await pending, { block: true, reason: 'too risky', answeredBy: 'human' });
});

test('approval broker deny without a reason uses a default', async () => {
  const broker = new ApprovalBroker();
  const pending = broker.register('t', 'a', 'bash', INPUT, '/repo');
  broker.decide('t', 'a', 'deny');
  assert.deepEqual(await pending, { block: true, reason: 'Denied from glasses', answeredBy: 'human' });
});

test('approval broker pushes pending then resolved to subscribers', async () => {
  const broker = new ApprovalBroker();
  const events: ApprovalBrokerEvent[] = [];
  const unsub = broker.subscribe((e) => events.push(e));

  const pending = broker.register('thread-1', 'call-1', 'edit', { file_path: '/x.ts' }, '/repo');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pending');
  assert.equal(events[0].type === 'pending' && events[0].view.threadId, 'thread-1');
  assert.equal(events[0].type === 'pending' && events[0].view.toolName, 'edit');
  assert.equal(events[0].type === 'pending' && events[0].view.cwd, '/repo');

  broker.decide('thread-1', 'call-1', 'allow');
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { type: 'resolved', threadId: 'thread-1', toolCallId: 'call-1' });
  await pending;

  unsub();
  const other = broker.register('thread-1', 'call-2', 'bash', INPUT, '/repo');
  assert.equal(events.length, 2, 'no events after unsubscribe');
  broker.cancelThread('thread-1', 'cleanup');
  await other;
});

test('approval broker emits resolved (default-deny) on cancel, cancelThread and abort', async () => {
  const broker = new ApprovalBroker();
  const resolved: string[] = [];
  broker.subscribe((e) => { if (e.type === 'resolved') resolved.push(e.toolCallId); });

  const p1 = broker.register('t', 'a', 'bash', INPUT, '/repo');
  assert.equal(broker.cancel('t', 'a', 'denied'), true);
  assert.deepEqual(await p1, { block: true, reason: 'denied', answeredBy: 'aborted' });

  const p2 = broker.register('t', 'b', 'bash', INPUT, '/repo');
  broker.cancelThread('t', 'dropped');
  assert.deepEqual(await p2, { block: true, reason: 'dropped', answeredBy: 'aborted' });

  const controller = new AbortController();
  const p3 = broker.register('t', 'c', 'bash', INPUT, '/repo', controller.signal);
  controller.abort('client gone');
  assert.deepEqual(await p3, { block: true, reason: 'client gone', answeredBy: 'aborted' });

  assert.deepEqual([...resolved].sort(), ['a', 'b', 'c']);
});

test('approval broker times out to a default-deny', async () => {
  const broker = new ApprovalBroker();
  const pending = broker.register('t', 'a', 'bash', INPUT, '/repo', undefined, 15);
  // The broker unrefs its timeout on purpose, so a pending approval can never hold
  // the backend process open. That leaves nothing keeping THIS test's event loop
  // alive while we await it: locally other work happens to, but on a CI runner the
  // loop drains first and the whole file dies with "Promise resolution is still
  // pending but the event loop has already resolved". Hold it open ourselves.
  const keepAlive = setTimeout(() => {}, 5_000);
  const decision = await pending;
  clearTimeout(keepAlive);
  assert.equal(decision.block, true);
  assert.match(decision.reason ?? '', /timed out/i);
  // The gate is gone after timing out.
  assert.equal(broker.hasPending('t'), false);
});

test('approval broker cancel returns false for an unknown gate', () => {
  const broker = new ApprovalBroker();
  assert.equal(broker.cancel('t', 'missing', 'x'), false);
});

test('approval broker isolates a throwing subscriber from resolution', async () => {
  const broker = new ApprovalBroker();
  broker.subscribe(() => { throw new Error('boom'); });
  const pending = broker.register('t', 'call-1', 'bash', INPUT, '/repo');
  assert.deepEqual(broker.decide('t', 'call-1', 'allow'), { ok: true });
  assert.deepEqual(await pending, { block: false, answeredBy: 'human' });
});

test('approval broker rejects duplicate registration', async () => {
  const broker = new ApprovalBroker();
  const first = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');
  await assert.rejects(broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo'), /already pending/i);
  broker.cancelThread('thread-1', 'cleanup');
  await first;
});

test('approval broker cancelThread resolves and removes all thread entries', async () => {
  const broker = new ApprovalBroker();
  const first = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');
  const second = broker.register('thread-1', 'call-2', 'edit', INPUT, '/repo');
  const other = broker.register('thread-2', 'call-1', 'bash', INPUT, '/repo');

  broker.cancelThread('thread-1', 'Run aborted');
  assert.deepEqual(await first, { block: true, reason: 'Run aborted', answeredBy: 'aborted' });
  assert.deepEqual(await second, { block: true, reason: 'Run aborted', answeredBy: 'aborted' });
  assert.equal(broker.decide('thread-1', 'call-1', 'allow').ok, false);

  broker.cancelThread('thread-2', 'cleanup');
  await other;
});

test('approval broker reports pending counts by thread', async () => {
  const broker = new ApprovalBroker();
  const one = broker.register('thread-1', 'call-1', 'bash', INPUT, '/repo');
  const two = broker.register('thread-1', 'call-2', 'bash', INPUT, '/repo');
  const other = broker.register('thread-2', 'call-3', 'bash', INPUT, '/repo');

  assert.equal(broker.pendingCount('thread-1'), 2);
  assert.equal(broker.hasPending('thread-1'), true);
  assert.equal(broker.pendingCount('missing'), 0);
  assert.equal(broker.hasPending('missing'), false);
  assert.equal(broker.listPending().length, 3);

  broker.cancelThread('thread-1', 'done');
  await Promise.all([one, two]);
  assert.equal(broker.pendingCount('thread-1'), 0);
  broker.cancelThread('thread-2', 'cleanup');
  await other;
});

test('approval extension gates a confirm decision and allows it on decide', async () => {
  const broker = new ApprovalBroker();
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createApprovalExtension('thread-1', '/repo', broker, () => 'confirm')({
    on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
      if (event === 'tool_call') handler = fn;
    },
  } as never);
  assert.ok(handler, 'registers a tool_call handler');

  let settled = false;
  const gate = handler!({ type: 'tool_call', toolName: 'bash', toolCallId: 'call-1', input: INPUT }, { signal: undefined })
    .then((r) => { settled = true; return r; });
  await Promise.resolve();
  assert.equal(settled, false, 'blocks on the pending gate');
  assert.equal(broker.hasPending('thread-1'), true);

  broker.decide('thread-1', 'call-1', 'allow');
  assert.deepEqual(await gate, { block: false, answeredBy: 'human' });
});

test('approval extension passes through when not supervised or tool is exempt', async () => {
  const broker = new ApprovalBroker();
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  let supervised = false;
  const policy = createToolPolicyResolver({ isSupervised: () => supervised });
  createApprovalExtension('thread-1', '/repo', broker, policy)({
    on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
      if (event === 'tool_call') handler = fn;
    },
  } as never);

  // Not supervised → undefined (allow), no gate parked.
  assert.equal(await handler!({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: INPUT }, { signal: undefined }), undefined);
  assert.equal(broker.hasPending('thread-1'), false);

  // Supervised but the exempt `question` tool → still undefined, no gate.
  supervised = true;
  assert.ok(UNGATED_TOOL_NAMES.has('question'));
  assert.equal(await handler!({ type: 'tool_call', toolName: 'question', toolCallId: 'c2', input: {} }, { signal: undefined }), undefined);
  assert.equal(broker.hasPending('thread-1'), false);

  // ...and the same resolver now gates bash, without the session being rebuilt.
  const gated = handler!({ type: 'tool_call', toolName: 'bash', toolCallId: 'c3', input: INPUT }, { signal: undefined });
  assert.equal(broker.hasPending('thread-1'), true, 'Supervise stays live per tool call');
  broker.cancelThread('thread-1', 'cleanup');
  await gated;
});

test('approval extension blocks a deny without parking a gate', async () => {
  const broker = new ApprovalBroker();
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createApprovalExtension('thread-1', '/repo', broker, () => 'deny')({
    on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
      if (event === 'tool_call') handler = fn;
    },
  } as never);

  const decision = await handler!({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: INPUT }, { signal: undefined }) as { block: boolean; reason: string };
  assert.equal(decision.block, true);
  assert.match(decision.reason, /blocked by policy/i);
  assert.match(decision.reason, /bash/);
  // Nothing waiting: a denied capability must not sit on the 5-minute timeout.
  assert.equal(broker.hasPending('thread-1'), false);
});

test('approval extension fails closed when the policy throws', async () => {
  const broker = new ApprovalBroker();
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createApprovalExtension('thread-1', '/repo', broker, () => { throw new Error('bad config'); })({
    on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
      if (event === 'tool_call') handler = fn;
    },
  } as never);

  // Side-effectful → parked for a human rather than waved through.
  const gated = handler!({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: INPUT }, { signal: undefined });
  assert.equal(broker.hasPending('thread-1'), true);
  broker.cancelThread('thread-1', 'cleanup');
  await gated;

  // Read-only → still allowed, so a broken policy cannot wedge every grep.
  assert.equal(await handler!({ type: 'tool_call', toolName: 'grep', toolCallId: 'c2', input: {} }, { signal: undefined }), undefined);
  assert.equal(broker.hasPending('thread-1'), false);
});
