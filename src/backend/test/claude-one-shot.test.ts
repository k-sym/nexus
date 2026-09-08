import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeOneShot } from '../engines/claude/one-shot';

const cfg = { enabled: true, auth: 'subscription' as const, oauth_token: '', executable_path: '', setting_sources: [], skills: 'all' as const };

function fakeQuery(messages: unknown[], capture: { options?: any; prompt?: unknown }) {
  return ((params: { prompt: unknown; options?: any }) => {
    capture.options = params.options;
    capture.prompt = params.prompt;
    return (async function* () { for (const m of messages) yield m; })();
  }) as any;
}

test('runs a tool-less single turn and returns the result text', async () => {
  const capture: { options?: any; prompt?: unknown } = {};
  const text = await runClaudeOneShot(cfg, { modelId: 'claude-sonnet-5', systemPrompt: 'sys', prompt: 'hi' },
    fakeQuery([{ type: 'assistant' }, { type: 'result', subtype: 'success', result: '{"ok":true}' }], capture));
  assert.equal(text, '{"ok":true}');
  assert.equal(capture.prompt, 'hi');
  assert.deepEqual(capture.options.tools, []);
  assert.equal(capture.options.maxTurns, 1);
  assert.equal(capture.options.persistSession, false);
  assert.equal(capture.options.model, 'claude-sonnet-5');
  assert.equal(capture.options.systemPrompt, 'sys');
  assert.ok(capture.options.env.CLAUDE_AGENT_SDK_CLIENT_APP);
});

test('surfaces an error result as a thrown error', async () => {
  await assert.rejects(
    runClaudeOneShot(cfg, { modelId: 'm', systemPrompt: 's', prompt: 'p' },
      fakeQuery([{ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }], {})),
    /boom/,
  );
});
