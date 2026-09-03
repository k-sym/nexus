import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker, decideToolCall } from '../pi/approvals';
import { createToolPolicyResolver } from '../pi/tool-policy';
import type { ToolDecisionRecord } from '../approvals/audit';

function recorder() {
  const records: ToolDecisionRecord[] = [];
  return { records, audit: { record: (r: ToolDecisionRecord) => { records.push(r); } } };
}

test('decideToolCall allows read-only tools without touching the broker and records nothing', async () => {
  const broker = new ApprovalBroker();
  const { records, audit } = recorder();
  const decision = await decideToolCall({
    threadId: 't', cwd: '/repo', toolName: 'read', toolCallId: 'c1', input: { path: 'a.ts' },
    broker, policy: createToolPolicyResolver(), audit,
  });
  assert.deepEqual(decision, { block: false });
  assert.equal(broker.pendingCount('t'), 0);
  assert.equal(records.length, 0);
});

test('decideToolCall denies outright when the policy says deny', async () => {
  const broker = new ApprovalBroker();
  const { records, audit } = recorder();
  const policy = createToolPolicyResolver({ categoryPolicy: () => ({ exec: 'deny' }) });
  const decision = await decideToolCall({
    threadId: 't', cwd: '/repo', toolName: 'bash', toolCallId: 'c2', input: { command: 'rm -rf /' },
    broker, policy, audit,
  });
  assert.equal(decision.block, true);
  assert.match(decision.reason ?? '', /Blocked by policy/);
  assert.equal(records[0]?.outcome, 'denied');
  assert.equal(records[0]?.answeredBy, 'policy');
});

test('decideToolCall parks confirm decisions on the broker and records how they settled', async () => {
  const broker = new ApprovalBroker();
  const { records, audit } = recorder();
  const policy = createToolPolicyResolver({ isSupervised: () => true });
  const pending = decideToolCall({
    threadId: 't', cwd: '/repo', toolName: 'bash', toolCallId: 'c3', input: { command: 'ls' },
    broker, policy, audit, timeoutMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(broker.pendingCount('t'), 1);
  broker.decide('t', 'c3', 'allow');
  const decision = await pending;
  assert.equal(decision.block, false);
  assert.equal(decision.answeredBy, 'human');
  assert.equal(records[0]?.outcome, 'allowed');
  assert.equal(records[0]?.answeredBy, 'human');
});
