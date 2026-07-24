import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  DbApprovalAudit,
  summarizeToolInput,
  MAX_INPUT_SUMMARY,
  type ApprovalAudit,
  type ToolDecisionRecord,
} from '../approvals/audit';
import { ApprovalBroker, createApprovalExtension } from '../pi/approvals';
import { createToolPolicyResolver } from '../pi/tool-policy';

// ── input summary ─────────────────────────────────────────────────────────────

test('summarizeToolInput pulls the intent field, bounds length, never throws', () => {
  assert.equal(summarizeToolInput({ command: 'docker compose up -d' }), 'docker compose up -d');
  assert.equal(summarizeToolInput({ url: 'http://localhost:3000/' }), 'http://localhost:3000/');
  assert.equal(summarizeToolInput('raw string'), 'raw string');
  assert.equal(summarizeToolInput({ weird: 1 }), '{"weird":1}');
  assert.equal(summarizeToolInput(null), '');
  assert.equal(summarizeToolInput(undefined), '');

  const long = summarizeToolInput({ command: 'x'.repeat(5000) });
  assert.ok(long.length <= MAX_INPUT_SUMMARY, `bounded to ${MAX_INPUT_SUMMARY}`);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(summarizeToolInput(cyclic), '', 'a cyclic input is empty, not a throw');
});

// ── DB sink ───────────────────────────────────────────────────────────────────

function tempAudit(): { audit: DbApprovalAudit; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-audit-'));
  const audit = new DbApprovalAudit(new Database(join(dir, 'nexus.db')));
  return { audit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const record = (over: Partial<ToolDecisionRecord> = {}): ToolDecisionRecord => ({
  threadId: 't1', cwd: '/repo', toolName: 'docker_service', category: 'services',
  inputSummary: 'up', decision: 'confirm', source: 'category',
  outcome: 'allowed', answeredBy: 'human', ...over,
});

test('DbApprovalAudit records and lists most-recent-first', () => {
  const { audit, cleanup } = tempAudit();
  try {
    audit.record(record({ toolName: 'bash', inputSummary: 'first' }));
    audit.record(record({ toolName: 'edit', inputSummary: 'second', decision: 'deny', source: 'rule', ruleTool: 'edit', ruleWhen: 'remote_host', outcome: 'denied', answeredBy: 'policy' }));

    const rows = audit.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tool_name, 'edit', 'newest first');
    assert.equal(rows[0].decision, 'deny');
    assert.equal(rows[0].source, 'rule');
    assert.equal(rows[0].rule_tool, 'edit');
    assert.equal(rows[0].rule_when, 'remote_host');
    assert.equal(rows[0].answered_by, 'policy');
    assert.equal(rows[1].tool_name, 'bash');
    assert.ok(rows[0].created_at, 'timestamped');
  } finally {
    cleanup();
  }
});

test('DbApprovalAudit.list honours a bounded limit', () => {
  const { audit, cleanup } = tempAudit();
  try {
    for (let i = 0; i < 5; i++) audit.record(record({ inputSummary: `n${i}` }));
    assert.equal(audit.list(3).length, 3);
    assert.equal(audit.list().length, 5);
  } finally {
    cleanup();
  }
});

// ── the extension records what it decides ─────────────────────────────────────

/** A capturing sink, for asserting exactly what the extension records. */
function capturingAudit(): { audit: ApprovalAudit; records: ToolDecisionRecord[] } {
  const records: ToolDecisionRecord[] = [];
  return { audit: { record: (r) => records.push(r) }, records };
}

/** Register the approval extension with a given policy + audit, return its handler. */
function handlerFor(policy: ReturnType<typeof createToolPolicyResolver>, audit: ApprovalAudit, broker = new ApprovalBroker()) {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createApprovalExtension('t1', '/repo', broker, policy, undefined, audit)({
    on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) { if (event === 'tool_call') handler = fn; },
  } as never);
  return { handler: handler!, broker };
}

test('a policy allow of a side-effectful tool is recorded; a plain read allow is not', async () => {
  const { audit, records } = capturingAudit();
  const policy = createToolPolicyResolver({ isSupervised: () => false }); // defaults: services confirm, rest allow
  const { handler } = handlerFor(policy, audit);

  // grep → allow, read-only, no rule → NOT recorded (noise).
  await handler({ type: 'tool_call', toolName: 'grep', toolCallId: 'c1', input: {} }, { signal: undefined });
  assert.equal(records.length, 0);

  // A rule that allows browser_navigate → recorded (a rule drove it).
  const ruled = createToolPolicyResolver({ isSupervised: () => false, rules: () => [{ tool: 'browser_navigate', decision: 'allow' }] });
  const { handler: h2 } = handlerFor(ruled, audit);
  await h2({ type: 'tool_call', toolName: 'browser_navigate', toolCallId: 'c2', input: { url: 'http://localhost/' } }, { signal: undefined });
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'allowed');
  assert.equal(records[0].answeredBy, 'policy');
  assert.equal(records[0].source, 'rule');
});

test('a policy deny is recorded immediately with its source', async () => {
  const { audit, records } = capturingAudit();
  const policy = createToolPolicyResolver({ isSupervised: () => false, categoryPolicy: () => ({ services: 'deny' }) });
  const { handler } = handlerFor(policy, audit);

  const result = await handler({ type: 'tool_call', toolName: 'docker_service', toolCallId: 'c1', input: { action: 'up' } }, { signal: undefined });
  assert.equal((result as { block: boolean }).block, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].outcome, 'denied');
  assert.equal(records[0].answeredBy, 'policy');
  assert.equal(records[0].category, 'services');
  assert.equal(records[0].inputSummary, 'up');
});

test('a confirm gate records its outcome and answerer once resolved', async () => {
  const { audit, records } = capturingAudit();
  const policy = createToolPolicyResolver({ isSupervised: () => true }); // confirm everything
  const { handler, broker } = handlerFor(policy, audit);

  // Human allows it.
  const gate = handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command: 'ls' } }, { signal: undefined });
  assert.equal(records.length, 0, 'not recorded until resolved');
  broker.decide('t1', 'c1', 'allow');
  await gate;
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'confirm');
  assert.equal(records[0].outcome, 'allowed');
  assert.equal(records[0].answeredBy, 'human');

  // Human denies the next one.
  const gate2 = handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c2', input: {} }, { signal: undefined });
  broker.decide('t1', 'c2', 'deny', 'nope');
  await gate2;
  assert.equal(records.at(-1)?.outcome, 'denied');
  assert.equal(records.at(-1)?.answeredBy, 'human');
});

test('a confirm gate denied by timeout records answeredBy timeout', async () => {
  const { audit, records } = capturingAudit();
  const policy = createToolPolicyResolver({ isSupervised: () => true });
  // Pin a tiny timeout so the gate auto-denies without a human.
  const broker = new ApprovalBroker();
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  createApprovalExtension('t1', '/repo', broker, policy, 15, audit)({
    on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) { if (event === 'tool_call') handler = fn; },
  } as never);

  const keepAlive = setTimeout(() => {}, 5_000);
  await handler!({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: {} }, { signal: undefined });
  clearTimeout(keepAlive);

  assert.equal(records.at(-1)?.outcome, 'denied');
  assert.equal(records.at(-1)?.answeredBy, 'timeout');
});
