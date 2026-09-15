import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../pi/runtime.js';
import { ClaudeEngine } from '../engines/claude/engine.js';
import { resolveClaudeAuthEnv } from '../engines/claude/auth.js';
import type { QueryFn } from '../engines/claude/session.js';

const base = { uuid: 'u', session_id: 'sdk-sess-9' };
const turn = [
  { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-opus-5', ...base },
  { type: 'assistant', parent_tool_use_id: null, ...base, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'result', subtype: 'success', is_error: false, result: 'hi', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn', ...base },
];
const queryFn = ((): any => Object.assign((async function* () { for (const m of turn) yield m; })(), { interrupt: async () => {} })) as unknown as QueryFn;

/** Like `queryFn` above, but records the options each call was made with. */
function recordingQueryFn() {
  const calls: Array<{ options: any }> = [];
  const fn = ((params: { options: any }) => {
    calls.push({ options: params.options });
    return Object.assign((async function* () { for (const m of turn) yield m; })(), { interrupt: async () => {} });
  }) as unknown as QueryFn;
  return { queryFn: fn, calls };
}

const enabled = { enabled: true, auth: 'subscription' as const, oauth_token: '', executable_path: '', setting_sources: [] as Array<'user' | 'project' | 'local'>, skills: 'all' as const };

async function makeRuntime(dir: string) {
  return PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') }, {
    recallMemories: async () => [],
  });
}

test('resolveClaudeAuthEnv is subscription-first', () => {
  const env = resolveClaudeAuthEnv(enabled, { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-live', HOME: '/h' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.match(env.CLAUDE_AGENT_SDK_CLIENT_APP ?? '', /^nexus\//);

  const withToken = resolveClaudeAuthEnv({ ...enabled, oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}' }, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  assert.equal(withToken.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  const unresolved = resolveClaudeAuthEnv({ ...enabled, oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}' }, {});
  assert.equal(unresolved.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  const apiKey = resolveClaudeAuthEnv({ ...enabled, auth: 'api_key' }, { ANTHROPIC_API_KEY: 'sk-live' });
  assert.equal(apiKey.ANTHROPIC_API_KEY, 'sk-live');
});

test('catalog and lookup follow the enabled flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    let cfg = { ...enabled };
    const engine = new ClaudeEngine({ pi, config: () => cfg, queryFn });
    assert.equal(engine.id, 'claude-code');
    assert.ok(engine.listModels().every((m) => m.configured === true && m.provider === 'claude-code'));
    assert.ok(engine.findModel('claude-code', 'claude-opus-5'));
    assert.equal(engine.findModel('anthropic', 'claude-opus-5'), undefined);
    cfg = { ...enabled, enabled: false };
    assert.ok(engine.listModels().every((m) => m.configured === false));
    assert.equal(engine.findModel('claude-code', 'claude-opus-5'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionFor caches per thread+cwd and writes into the Pi session directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn });
    const a = await engine.sessionFor('thread-1', '/repo');
    const b = await engine.sessionFor('thread-1', '/repo');
    assert.strictEqual(a, b);
    assert.equal(engine.hasSession('thread-1', '/repo'), true);
    await a.prompt('hello');
    const entries = await pi.readMessages('thread-1', '/repo');
    assert.deepEqual(entries.map((e: any) => e.message.role), ['user', 'assistant']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dropping the Pi session also deletes the SDK transcript, even after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const deleted: string[] = [];
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn, deleteSdkSession: async (id, cwd) => { deleted.push(`${id}@${cwd}`); } });
    const session = await engine.sessionFor('thread-1', '/repo');
    await session.prompt('hello');
    // Simulate a restart: a fresh engine with no cached session must still find the id on disk.
    const cold = new ClaudeEngine({ pi, config: () => enabled, queryFn, deleteSdkSession: async (id, cwd) => { deleted.push(`cold:${id}@${cwd}`); } });
    void cold;
    pi.dropSession('thread-1', '/repo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(deleted.includes('sdk-sess-9@/repo'));
    assert.ok(deleted.includes('cold:sdk-sess-9@/repo'));
    assert.equal(engine.hasSession('thread-1', '/repo'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transcript shared with Claude Desktop survives dropping the thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const deleted: string[] = [];
    const logs: string[] = [];
    let shared = false;
    const engine = new ClaudeEngine({
      pi, config: () => enabled, queryFn,
      deleteSdkSession: async (id) => { deleted.push(id); },
      isTranscriptShared: () => shared,
      log: (line) => logs.push(line),
    });
    const session = await engine.sessionFor('thread-1', '/repo');
    await session.prompt('hello');
    shared = true;
    pi.dropSession('thread-1', '/repo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(deleted, []);
    assert.ok(logs.some((line) => /shared with Claude Desktop; left in place/.test(line)));
    assert.equal(engine.hasSession('thread-1', '/repo'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importSdkSession seeds a new thread from a Claude transcript and records the session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const transcript = [
      { type: 'user', uuid: 'u1', session_id: 'desk-1', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: 'Where is the badge?' } },
      { type: 'assistant', uuid: 'a1', session_id: 'desk-1', parent_tool_use_id: null, parent_agent_id: null, message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'In KanbanBoard.tsx.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const { queryFn: recording, calls } = recordingQueryFn();
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn: recording, getSessionMessages: async () => transcript as any });
    const result = await engine.importSdkSession('thread-9', '/repo', 'desk-1');
    assert.equal(result.appended, 2);
    assert.equal(result.modelKey, 'claude-code/claude-sonnet-5');
    const entries = await pi.readMessages('thread-9', '/repo');
    assert.deepEqual(entries.map((e: any) => e.message.role), ['user', 'assistant']);
    // The next turn resumes the imported session rather than starting a new one.
    const session = await engine.sessionFor('thread-9', '/repo');
    assert.equal(session.engineSessionId, 'desk-1');
    await session.prompt('and the chip?');
    assert.equal(calls[0].options.resume, 'desk-1');
    await assert.rejects(engine.importSdkSession('thread-9', '/repo', 'desk-1'), /already has a live Claude session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session appends the project AGENTS.md to the system prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const project = join(dir, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'Prefer tabs.');
    const { queryFn: recording, calls } = recordingQueryFn();
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn: recording });
    const session = await engine.sessionFor('thread-1', project);
    await session.prompt('hello');
    assert.match(calls[0].options.systemPrompt.append, /Prefer tabs\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLAUDE.md is appended only when the SDK is not loading project settings itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const project = join(dir, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'CLAUDE.md'), 'Use pnpm.');

    const { queryFn: withProject, calls: projectCalls } = recordingQueryFn();
    const engineWithProjectSettings = new ClaudeEngine({ pi, config: () => ({ ...enabled, setting_sources: ['project'] }), queryFn: withProject });
    const sessionA = await engineWithProjectSettings.sessionFor('thread-a', project);
    await sessionA.prompt('hello');
    assert.doesNotMatch(projectCalls[0].options.systemPrompt.append ?? '', /Use pnpm\./);

    const { queryFn: withoutProject, calls: noProjectCalls } = recordingQueryFn();
    const engineWithoutProjectSettings = new ClaudeEngine({ pi, config: () => ({ ...enabled, setting_sources: [] }), queryFn: withoutProject });
    const sessionB = await engineWithoutProjectSettings.sessionFor('thread-b', project);
    await sessionB.prompt('hello');
    assert.match(noProjectCalls[0].options.systemPrompt.append, /Use pnpm\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Scout child enforces native tools, isolates transcript and retains parent policy routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-child-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const recording = recordingQueryFn();
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn: recording.queryFn });
    const child = await engine.createChildSession({ id: 'child-one', parentThreadId: 'parent', cwd: dir, role: 'scout', prompt: 'Scout only.' });
    await child.prompt('Find callers');
    const options = recording.calls[0].options;
    assert.ok(options.disallowedTools.includes('Edit'));
    assert.ok(options.disallowedTools.includes('Agent'));
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.skills, []);
    const denial = await options.canUseTool('mcp__other__write', {}, { toolUseID: 'bad', signal: new AbortController().signal });
    assert.equal(denial.behavior, 'deny');
    const entries = await pi.readMessages('child-one', dir);
    assert.ok(entries.length > 0);
    assert.equal((await pi.readMessages('parent', dir)).length, 0);
    assert.equal(engine.hasSession('child-one', dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Pi child exposes the Scout allowlist and disposal retains audit entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-child-'));
  try {
    const pi = await makeRuntime(dir);
    const session = await pi.createChildSession({ id: 'child-pi', parentThreadId: 'parent', cwd: dir, role: 'scout', prompt: 'Scout only.' });
    assert.deepEqual(session.getActiveToolNames().sort(), ['find', 'grep', 'ls', 'read']);
    session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Scout' }] } as any);
    session.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Evidence retained' }] } as any);
    session.dispose();
    assert.ok((await pi.readMessages('child-pi', dir)).some((entry: any) => entry.message?.content?.[0]?.text === 'Evidence retained'));
    assert.equal(pi.hasSession('child-pi', dir), false);
    assert.ok(pi.models.find('openai', 'gpt-5.6-sol'));
    assert.ok(pi.models.find('openrouter', 'z-ai/glm-5.2'));
    assert.ok(pi.models.getAll().filter(m => m.provider === 'openai').length > 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('disposing a child session removes its SDK transcript but keeps the child JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const deleted: string[] = [];
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn, deleteSdkSession: async (id, cwd) => { deleted.push(`${id}@${cwd}`); } });
    const child = await engine.createChildSession({ id: 'child-1', parentThreadId: 'thread-1', cwd: '/repo', role: 'scout', prompt: 'Scout the repo.' });
    // Children never enter the engine's session map, so dropSession cannot reach them.
    assert.equal(engine.hasSession('child-1', '/repo'), false);
    await child.prompt('Find callers');
    assert.equal(child.engineSessionId, 'sdk-sess-9');
    child.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(deleted, ['sdk-sess-9@/repo']);
    // The child's own Pi JSONL (the retained role record) is untouched.
    const entries = await pi.readMessages('child-1', '/repo');
    assert.deepEqual(entries.map((e: any) => e.message.role), ['user', 'assistant']);
    // A child that never ran a turn has no SDK transcript to remove.
    const idle = await engine.createChildSession({ id: 'child-2', parentThreadId: 'thread-1', cwd: '/repo', role: 'scout', prompt: 'Scout.' });
    idle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(deleted, ['sdk-sess-9@/repo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
