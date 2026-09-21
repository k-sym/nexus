import { readWebDocument } from '../roles/web-fetch.js';
import { labelledApprovals, labelledQuestions } from '../roles/brokers.js';
import { ApprovalBroker } from '../pi/approvals.js';
import { QuestionBroker } from '../pi/questions.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DEFAULT_ROLE_MODELS, ROLE_NAMES, type RoleModels } from '@nexus/shared';
import { RoleRunner } from '../roles/runner.js';
import { allowsRoleTool, restrictedFactories } from '../roles/definitions.js';
import { ConcurrencyTracker } from '../pi/concurrency.js';
import { EngineRegistry } from '../engines/registry.js';
import { collectPiTools } from '../engines/claude/pi-tools-bridge.js';
import { readOverrides, roleView, validateRoleOverrides, validateRolesConfig } from '../roles/config.js';
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
  const roleEvents: any[] = [];
  const finish = runner.bind({ onRole: event => roleEvents.push(event), threadId: 't', projectId: 'p', cwd: '/tmp', runId: 'parent', owner }, parent);
  return { db, runner, parent, roleEvents, emitParent: (event: any) => parentListener(event), finish, concurrency, owner, engines, get options() { return options; }, get aborts() { return aborts; }, get disposed() { return disposed; } };
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
    assert.equal(s.roleEvents[0].partialResult.details.childRunId, result.details.childRunId);
    assert.equal(s.roleEvents[0].partialResult.details.status, 'running');
    assert.equal(s.options.parentToolCallId, 'call');
    assert.equal(result.details.status, 'completed'); assert.equal(result.details.tokens, 12);
    assert.equal(s.options.parentThreadId, 't'); assert.notEqual(s.options.id, 't');
    const row = s.db.prepare('SELECT * FROM role_runs').get() as any;
    assert.equal(row.parent_run_id, 'parent'); assert.equal(row.parent_tool_call_id, 'call'); assert.match(row.report, /three call sites/);
    assert.equal(s.disposed, true);
    await s.finish(); assert.equal(s.concurrency.releaseProject('p', s.owner), true);
  } finally { s.db.close(); }
});
test('a pending child question pauses the time ceiling and resumes it once answered', async () => {
  const askedAt = { start: 0 };
  const s = setup(async emit => {
    emit({ type: 'tool_execution_start', toolCallId: 'ask', toolName: 'question', args: { questions: [{ id: 'q', header: 'Heading', question: 'Which?', options: [] }] } });
    askedAt.start = Date.now();
    await new Promise(resolve => setTimeout(resolve, 220));
    emit({ type: 'tool_execution_end', toolCallId: 'ask', toolName: 'question', result: { content: [] } });
    emit(message);
  }, { max_minutes: 0.002 });
  try {
    const tools = await collectPiTools(s.runner.factories('t'));
    const result = await tools[0].execute('call', { brief: 'Build it' }, undefined, undefined, {} as any);
    assert.equal(result.details.status, 'completed');
    assert.ok(Date.now() - askedAt.start > 120, 'the wait outlasted the ceiling');
    assert.equal(s.roleEvents.some(e => String(e.partialResult?.details?.report ?? '').includes('Time ceiling')), false);
  } finally { s.db.close(); }
});
test('the time ceiling still stops a child that is working, not waiting', async () => {
  const s = setup(async () => { await new Promise(resolve => setTimeout(resolve, 250)); }, { max_minutes: 0.002 });
  try {
    const tools = await collectPiTools(s.runner.factories('t'));
    const result = await tools[0].execute('call', { brief: 'Build it' }, undefined, undefined, {} as any);
    assert.match(result.details.report, /Time ceiling reached/);
    assert.equal(s.aborts, 1);
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
    const fakeModels = Object.fromEntries(ROLE_NAMES.map(r => [r, 'fake/model'])) as RoleModels;
    assert.equal(validateRolesConfig({ ...config, models: fakeModels }, s.engines), undefined);
    assert.match(validateRolesConfig({ ...config, models: { ...fakeModels, scout: 'fake/missing' } }, s.engines)!, /Unknown model for scout: fake\/missing/);
    // A saved selection survives its model leaving the catalog (visible as unavailable); only a new pick must be registered.
    const saved = { ...config, models: { ...fakeModels, scout: 'fake/missing' } };
    assert.equal(validateRolesConfig(saved, s.engines, saved), undefined);
    assert.match(validateRolesConfig({ ...saved, models: { ...saved.models, builder: 'fake/other' } }, s.engines, saved)!, /Unknown model for builder/);
    assert.equal(validateRolesConfig(saved), undefined, 'without a registry only the shape is checked');
    assert.match(validateRolesConfig({ ...saved, models: { ...saved.models, refuter: 'no-slash' } })!, /provider\/model/);
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
const publicHost = async () => [{ address: '93.184.216.34', family: 4 }];
test('research document reads reject credentials and binary data and bound response size', async () => {
  await assert.rejects(readWebDocument('file:///etc/passwd'), /HTTP/);
  await assert.rejects(readWebDocument('https://user:password@example.com'), /credentials/);
  await assert.rejects(readWebDocument('https://example.com', undefined, (async () => new Response('x', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch, publicHost), /Unsupported/);
  const result = await readWebDocument('https://example.com', undefined, (async () => new Response('x'.repeat(200000))) as typeof fetch, publicHost);
  assert.match(result, /truncated/); assert.ok(result.length < 128200);
});
test('research document reads refuse private, loopback, link-local and Tailscale hosts on every hop', async () => {
  const never = (async () => { throw new Error('fetch must not be called'); }) as typeof fetch;
  const literal = async (hostname: string) => [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
  for (const host of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[fe80::1]', '[fd00::1]']) {
    await assert.rejects(readWebDocument(`http://${host}:4100/`, undefined, never, literal), /private, loopback/, host);
  }
  await assert.rejects(readWebDocument('http://localhost:4173/api/health', undefined, never, async () => [{ address: '127.0.0.1', family: 4 }]), /private, loopback/);
  // A public name with even one private record is refused; a name that does not resolve is refused.
  await assert.rejects(readWebDocument('http://mixed.example', undefined, never, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), /private, loopback/);
  await assert.rejects(readWebDocument('http://unknown.example', undefined, never, async () => { throw new Error('ENOTFOUND'); }), /Could not resolve/);
  assert.equal(await readWebDocument('http://[2606:4700::1111]/', undefined, (async () => new Response('v6 ok')) as typeof fetch, literal).then(text => text.includes('v6 ok')), true);
  // Redirects are followed by hand and re-checked: public → private stops before the second fetch, public → public is read.
  const hops: string[] = [];
  const resolver = async (hostname: string) => [{ address: hostname.endsWith('.example') ? '93.184.216.34' : hostname, family: 4 }];
  const toPrivate = (async (input: URL) => { hops.push(input.href); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8899/' } }); }) as typeof fetch;
  await assert.rejects(readWebDocument('http://start.example/doc', undefined, toPrivate, resolver), /private, loopback/);
  assert.deepEqual(hops, ['http://start.example/doc']);
  const toPublic = (async (input: URL, init: RequestInit) => {
    assert.equal(init.redirect, 'manual'); hops.push(input.href);
    return input.hostname === 'start.example' ? new Response(null, { status: 301, headers: { location: '//end.example/final' } }) : new Response('moved here');
  }) as typeof fetch;
  hops.length = 0;
  const followed = await readWebDocument('http://start.example/doc', undefined, toPublic, resolver);
  assert.deepEqual(hops, ['http://start.example/doc', 'http://end.example/final']); assert.match(followed, /Source: http:\/\/end\.example\/final\nmoved here/);
  const loop = (async (input: URL) => new Response(null, { status: 307, headers: { location: input.href } })) as typeof fetch;
  await assert.rejects(readWebDocument('http://start.example/loop', undefined, loop, resolver), /Too many redirects/);
});
test('corrupt per-thread role overrides are dropped with a log line', () => {
  const lines: string[] = [];
  assert.deepEqual(readOverrides('{not json', 'thread t', line => lines.push(line)), {});
  assert.equal(lines.length, 1); assert.match(lines[0], /corrupt role_models for thread t/);
  assert.deepEqual(readOverrides(null, 'thread t', line => lines.push(line)), {});
  assert.deepEqual(readOverrides('{"scout":"fake/model","bogus":1,"builder":3}', 'thread t', line => lines.push(line)), { scout: 'fake/model' });
  assert.equal(lines.length, 1, 'only unparseable JSON is logged');
});
