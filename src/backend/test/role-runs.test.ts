import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { registerRoleRunRoutes } from '../routes/role-runs.js';
import { flattenEntries } from '../routes/chat.js';
import { ApprovalBroker } from '../pi/approvals.js';
import { labelledApprovals } from '../roles/brokers.js';
import { toPendingDto } from '../routes/approvals.js';
import { AGENT_RUN_CUSTOM_TYPE } from '@nexus/shared';

const child = { childRunId: 'child-1', role: 'scout', model: 'fake/model', tokens: 12, durationMs: 100, status: 'completed' };
const entries = [
  { type: 'message', id: 'a', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.ts' } }] } },
  { type: 'message', id: 'b', message: { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'source' }] } },
  { type: 'message', id: 'c', message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } },
];

test('child route resolves only ledger-owned sessions, projects tools and approval decisions', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT, repo_path TEXT); INSERT INTO projects VALUES ('p','/repo');
    CREATE TABLE chat_threads(id TEXT, project_id TEXT); INSERT INTO chat_threads VALUES ('t','p');
    CREATE TABLE role_runs(id TEXT, thread_id TEXT, role TEXT, model_key TEXT, status TEXT, tokens INTEGER, duration_ms INTEGER, report TEXT);
    INSERT INTO role_runs VALUES ('child-1','t','scout','fake/model','completed',12,100,'Reviewed.');`);
  let reads: string[] = [];
  let available = true;
  let running = false;
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('pi', { readMessages: async (id: string, cwd: string) => {
    assert.equal(cwd, '/repo'); reads.push(id);
    if (id === 't') return [{ type: 'custom', customType: 'nexus.approval_decision', data: { childRunId: 'child-1', toolCallId: 'read-1', outcome: 'allowed', answeredBy: 'human' } }];
    return available ? (running ? [entries[0]] : entries) : [];
  } } as any);
  await registerRoleRunRoutes(app);
  try {
    const response = await app.inject('/api/runs/child-1/events');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.child.report, 'Reviewed.');
    assert.equal(body.transcriptAvailable, true);
    assert.equal(body.messages[0].tool_calls[0].id, 'read-1');
    assert.equal(body.messages[0].tool_calls[0].approval.outcome, 'allowed');
    assert.equal(body.messages.at(-1).content, 'Reviewed.');
    running = true;
    db.prepare("UPDATE role_runs SET status = 'running'").run();
    assert.equal((await app.inject('/api/runs/child-1/events')).json().messages[0].tool_calls[0].status, 'running');
    available = false;
    assert.equal((await app.inject('/api/runs/child-1/events')).json().transcriptAvailable, false);
    reads = [];
    assert.equal((await app.inject('/api/runs/%2E%2E%2Fsecret/events')).statusCode, 404);
    assert.deepEqual(reads, []);
  } finally { await app.close(); db.close(); }
});

test('role metadata survives history for both structured results and early child linkage', () => {
  const start = { type: 'message', id: 'parent', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'delegate', name: 'scout', arguments: {} }] } };
  const link = { type: 'custom', customType: 'nexus.role_run', data: { toolCallId: 'delegate', partialResult: { details: { ...child, status: 'running' } } } };
  const result = { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: 'delegate', content: [{ type: 'text', text: 'Report' }], details: child } };
  const done = flattenEntries([start, link, result]) as any[];
  assert.deepEqual(done[0].tool_calls[0].details, child);
  const interrupted = flattenEntries([start, link]) as any[];
  assert.equal(interrupted[0].tool_calls[0].details.childRunId, child.childRunId);
  assert.equal(interrupted[0].tool_calls[0].details.status, 'interrupted');
});

test('a forwarded child question stays answerable in history while the parent run is active', async () => {
  const runStart = { type: 'custom', customType: AGENT_RUN_CUSTOM_TYPE, data: { event: 'start', runId: 'r', threadId: 't', startedAt: '2026-09-20T19:49:47Z', provider: 'p', model: 'm' } };
  const parent = { type: 'message', id: 'parent', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'delegate', name: 'build', arguments: {} }] } };
  const asked = { type: 'custom', id: 'ask', customType: 'nexus-role-question', data: { type: 'tool_execution_start', toolCallId: 'ask-1', args: { questions: [{ id: 'q', header: 'Builder · Heading', question: 'Which heading?', options: [] }] }, timestamp: 2 } };
  const live = flattenEntries([runStart, parent, asked], '/repo', { activeRunIds: new Set(['r']), activeThreadIds: new Set(['t']) }) as any[];
  const liveCalls = live.flatMap(m => m.tool_calls ?? []);
  assert.equal(liveCalls.find((c: any) => c.id === 'ask-1').status, 'running');
  assert.equal(liveCalls.find((c: any) => c.id === 'delegate').status, 'running');
  const dead = flattenEntries([runStart, parent, asked], '/repo') as any[];
  assert.equal(dead.flatMap(m => m.tool_calls ?? []).find((c: any) => c.id === 'ask-1').status, 'interrupted');
});

test('child approval carries identity through pending DTO and resolution without changing permission behavior', async () => {
  const broker = new ApprovalBroker();
  const events: any[] = [];
  broker.subscribe(e => events.push(e));
  const labelled = labelledApprovals(broker, 'builder', { childRunId: 'child-1', parentToolCallId: 'delegate' });
  const promise = labelled.register('t', 'edit-1', 'edit', { path: 'a.ts' }, '/repo', undefined, 0);
  const dto = toPendingDto(broker.listPending()[0]);
  assert.equal(dto.childRunId, 'child-1'); assert.equal(dto.parentToolCallId, 'delegate');
  broker.decide('t', 'edit-1', 'deny', 'Needs changes');
  assert.equal((await promise).block, true);
  assert.equal(events[1].resolution.childRunId, 'child-1');
  assert.equal(events[1].resolution.parentToolCallId, 'delegate');
});
