import { readWebDocument } from '../roles/web-fetch.js';
import { labelledApprovals, labelledQuestions } from '../roles/brokers.js';
import { ApprovalBroker } from '../pi/approvals.js';
import { QuestionBroker } from '../pi/questions.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DEFAULT_ROLE_MODELS } from '@nexus/shared';
import { RoleRunner } from '../roles/runner.js';
import { allowsRoleTool, restrictedFactories } from '../roles/definitions.js';
import { ConcurrencyTracker } from '../pi/concurrency.js';
import { EngineRegistry } from '../engines/registry.js';
import { collectPiTools } from '../engines/claude/pi-tools-bridge.js';
import { roleView, validateRoleOverrides, validateRolesConfig } from '../roles/config.js';
import type { EngineSession, ChatEngine } from '../engines/types.js';
const config = { enabled: true, models: { ...DEFAULT_ROLE_MODELS, scout: 'fake/model' }, max_turns: 30, max_minutes: 20, max_tokens: 400000 };
function setup(action: (emit: (event: any) => void) => Promise<void>, limits = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE chat_threads(id TEXT, role_models TEXT); INSERT INTO chat_threads VALUES ('t', NULL);
  CREATE TABLE role_runs(id TEXT, parent_run_id TEXT, parent_tool_call_id TEXT, thread_id TEXT, role TEXT, model_key TEXT, status TEXT, started_at TEXT, report TEXT, tokens INTEGER, completed_at TEXT, duration_ms INTEGER);`);
  let listener = (_: any) => {}, aborts = 0, disposed = false, options: any;
  const child = { subscribe: (fn: any) => { listener = fn; return () => {}; }, prompt: () => action(event => listener(event)), setModel: async () => {}, abort: async () => { aborts++; }, dispose: () => { disposed = true; } } as unknown as EngineSession;
  const model = { provider: 'fake', id: 'model', name: 'Fake', configured: true };
  const engine: ChatEngine = { id: 'pi', listModels: () => [model], findModel: (p, id) => p === 'fake' && id === 'model' ? model : undefined, sessionFor: async () => child, hasSession: () => false, dropSession: () => { throw new Error('Must not delete transcript'); }, createChildSession: async opts => { options = opts; return child; } };
  const engines = new EngineRegistry([engine]), concurrency = new ConcurrencyTracker();
  const owner = concurrency.claimProject('p', 't', 'Test', 'chat')!;
  const runner = new RoleRunner({ db, engines, concurrency, config: { ...config, ...limits } });
  let parentListener = (_: any) => {};
  const parent = { abort: async () => {}, subscribe: (fn: any) => { parentListener = fn; return () => {}; } } as EngineSession;
  const finish = runner.bind({ threadId: 't', projectId: 'p', cwd: '/tmp', runId: 'parent', owner }, parent);
  return { db, runner, parent, emitParent: (event: any) => parentListener(event), finish, concurrency, owner, engines, get options() { return options; }, get aborts() { return aborts; }, get disposed() { return disposed; } };
}
const message = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Found three call sites.' }], usage: { totalTokens: 12 }, stopReason: 'stop' } };
test('role restrictions cover both native and MCP aliases, including recursive delegation', async () => {
  for (const name of ['Edit', 'Write', 'Bash', 'mcp__nexus__build', 'Agent', 'Task']) assert.equal(allowsRoleTool('scout', name), false, name);
  assert.equal(allowsRoleTool('refuter', 'Bash'), true);
  assert.equal(allowsRoleTool('researcher', 'WebSearch'), true);
  assert.equal(allowsRoleTool('builder', 'Agent'), false);
  assert.equal(allowsRoleTool('debugger', 'mcp__nexus__refute'), false);
  const tools = await collectPiTools(restrictedFactories([api => { for (const name of ['read', 'edit', 'build']) api.registerTool({ name } as any); }], 'scout'));
  assert.deepEqual(tools.map(t => t.name), ['read']);
});
test('child runs preserve execution identity, report, usage and parent tool link', async () => {
  const s = setup(async emit => { emit(message); });
  try {
    const tools = await collectPiTools(s.runner.factories('t'));
    const result = await tools[0].execute('call', { brief: 'Find callers' }, undefined, undefined, {} as any);
    assert.equal(result.details.status, 'completed'); assert.equal(result.details.tokens, 12);
    assert.equal(s.options.parentThreadId, 't'); assert.notEqual(s.options.id, 't');
    const row = s.db.prepare('SELECT * FROM role_runs').get() as any;
    assert.equal(row.parent_run_id, 'parent'); assert.equal(row.parent_tool_call_id, 'call'); assert.match(row.report, /three call sites/);
    assert.equal(s.disposed, true);
    await s.finish(); assert.equal(s.concurrency.releaseProject('p', s.owner), true);
  } finally { s.db.close(); }
});
test('abort does not release ownership while a stubborn child is still executing', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const wait = new Promise<void>(r => { release = r; });
  const s = setup(async () => { started(); await wait; });
  try {
    const tools = await collectPiTools(s.runner.factories('t'));
    const pending = tools[0].execute('first', { brief: 'Scout' }, undefined, undefined, {} as any);
    await ready;
    await assert.rejects(tools[0].execute('second', { brief: 'Scout' }, undefined, undefined, {} as any), /already running/);
    await s.parent.abort(); assert.equal(s.aborts, 1);
    assert.equal(s.concurrency.releaseProject('p', s.owner), false);
    let finished = false; const finishing = s.finish().then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false);
    release(); const result = await pending; await finishing;
    assert.equal(result.details.status, 'incomplete'); assert.equal(s.concurrency.releaseProject('p', s.owner), true);
  } finally { release(); s.db.close(); }
});
for (const [limit, value] of [['max_turns', 1], ['max_tokens', 10]] as const) test(`${limit} returns partial evidence`, async () => {
  const s = setup(async emit => { emit(message); }, { [limit]: value });
  try {
    const tools = await collectPiTools(s.runner.factories('t')); const result = await tools[0].execute('call', { brief: 'Scout' }, undefined, undefined, {} as any);
    assert.equal(result.details.status, 'incomplete'); assert.match(result.content[0].text, /Found three call sites/); assert.equal(s.aborts, 1); await s.finish();
  } finally { s.db.close(); }
});
test('configuration rejects bad roles and unavailable selections fail without fallback', async () => {
  const s = setup(async () => { throw new Error('Should not run'); });
  try {
    assert.throws(() => validateRoleOverrides({ bogus: 'fake/model' }, s.engines), /Unknown role/);
    assert.throws(() => validateRoleOverrides({ scout: 'fake/missing' }, s.engines), /Unknown model/);
    assert.deepEqual(validateRoleOverrides({ scout: null }, s.engines), {});
    assert.match(validateRolesConfig({ ...config, max_turns: 0 })!, /max_turns/);
    assert.equal(roleView(config, {}, s.engines).available.refuter, false);
    const tools = await collectPiTools(s.runner.factories('t'));
    await assert.rejects(tools.find(t => t.name === 'refute')!.execute('call', { brief: 'Review' }, undefined, undefined, {} as any), /unavailable/);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM role_runs').get().n, 0); await s.finish();
  } finally { s.db.close(); }
});
test('stale project owners cannot start children', async () => {
  const c = new ConcurrencyTracker(), owner = c.claimProject('p', 't', 'x', 'chat')!;
  c.releaseProject('p', owner); c.claimProject('p', 'other', 'y', 'chat');
  await assert.rejects(c.runAsChild('p', owner, async () => {}), /no longer owns/);
});
test('time ceiling aborts the child and waits for its actual completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const wait = new Promise<void>(r => { release = r; });
  const s = setup(async emit => { emit(message); started(); await wait; });
  try {
    const tools = await collectPiTools(s.runner.factories('t'));
    const run = tools[0].execute('call', { brief: 'Scout' }, undefined, undefined, {} as any);
    await ready; t.mock.timers.tick(20 * 60000);
    assert.equal(s.aborts, 1); assert.equal(s.concurrency.releaseProject('p', s.owner), false);
    release(); const result = await run; assert.match(result.content[0].text, /Time ceiling/); await s.finish();
  } finally { release(); s.db.close(); }
});
test('a parent tool already in flight prevents child startup', async () => {
  const s = setup(async emit => emit(message));
  try {
    s.emitParent({ type: 'tool_execution_start', toolCallId: 'bash', toolName: 'Bash' });
    const tools = await collectPiTools(s.runner.factories('t'));
    await assert.rejects(tools[0].execute('call', { brief: 'Scout' }, undefined, undefined, {} as any), /other tool calls finish/);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM role_runs').get().n, 0);
    s.emitParent({ type: 'tool_execution_end', toolCallId: 'bash' });
    assert.equal((await tools[0].execute('call', { brief: 'Scout' }, undefined, undefined, {} as any)).details.status, 'completed');
    await s.finish();
  } finally { s.db.close(); }
});
test('child brokers keep parent routing and label human interactions', async () => {
  const approvals = new ApprovalBroker(), questions = new QuestionBroker();
  const signal = new AbortController();
  const pending = labelledApprovals(approvals, 'builder').register('parent', 'call', 'edit', {}, '/tmp', signal.signal);
  assert.equal(approvals.listPending()[0].threadId, 'parent');
  assert.equal(approvals.listPending()[0].toolName, 'Builder · edit');
  const question = labelledQuestions(questions, 'debugger').register('parent', 'q', { questions: [{ id: 'q', header: 'Scope', question: 'Which?', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], multiple: false, allowOther: false }] }, signal.signal);
  assert.equal(questions.listPending()[0].request.questions[0].header, 'Debugger · Scope');
  signal.abort(); await pending; await question;
  assert.equal(approvals.listPending().length, 0); assert.equal(questions.listPending().length, 0);
});
test('research document reads reject credentials and binary data and bound response size', async () => {
  await assert.rejects(readWebDocument('file:///etc/passwd'), /HTTP/);
  await assert.rejects(readWebDocument('https://user:password@example.com'), /credentials/);
  await assert.rejects(readWebDocument('https://example.com', undefined, (async () => new Response('x', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch), /Unsupported/);
  const result = await readWebDocument('https://example.com', undefined, (async () => new Response('x'.repeat(200000))) as typeof fetch);
  assert.match(result, /truncated/); assert.ok(result.length < 128200);
});
