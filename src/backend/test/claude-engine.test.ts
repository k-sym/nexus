import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

const enabled = { enabled: true, auth: 'subscription' as const, oauth_token: '', executable_path: '' };

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
