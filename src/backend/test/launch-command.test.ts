import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchCommand, shellSingleQuote } from '../pty/launch-command';

test('shellSingleQuote wraps and escapes single quotes', () => {
  assert.equal(shellSingleQuote(`it's`), `'it'\\''s'`);
  assert.equal(shellSingleQuote('plain'), `'plain'`);
});

test('claude_code new thread appends the system prompt', () => {
  const cmd = buildLaunchCommand({ providerKind: 'claude_code', systemPrompt: 'Be terse.' });
  assert.equal(cmd, `claude --append-system-prompt 'Be terse.'`);
});

test('claude_code with a session id resumes (ignores system prompt)', () => {
  const cmd = buildLaunchCommand({ providerKind: 'claude_code', systemPrompt: 'x', sessionId: 'abc-123' });
  assert.equal(cmd, 'claude --resume abc-123');
});

test('claude_code ignores an unsafe session id and falls back to append', () => {
  const cmd = buildLaunchCommand({ providerKind: 'claude_code', systemPrompt: 'x', sessionId: 'bad; rm -rf /' });
  assert.equal(cmd, `claude --append-system-prompt 'x'`);
});

test('claude_code with no system prompt is bare claude', () => {
  assert.equal(buildLaunchCommand({ providerKind: 'claude_code' }), 'claude');
});

test('codex returns the codex CLI', () => {
  assert.equal(buildLaunchCommand({ providerKind: 'codex', systemPrompt: 'x' }), 'codex');
});

test('other providers get an empty command (plain shell)', () => {
  assert.equal(buildLaunchCommand({ providerKind: 'openrouter', systemPrompt: 'x' }), '');
  assert.equal(buildLaunchCommand({ providerKind: 'local' }), '');
});

test('opencode launches the TUI with model and args', () => {
  assert.equal(
    buildLaunchCommand({ providerKind: 'opencode', model: 'openrouter/x/y', args: '--agent build' }),
    'opencode --model openrouter/x/y --agent build',
  );
});
test('opencode with no model is bare opencode', () => {
  assert.equal(buildLaunchCommand({ providerKind: 'opencode' }), 'opencode');
});
test('opencode ignores systemPrompt (chat does not inject one either)', () => {
  assert.equal(buildLaunchCommand({ providerKind: 'opencode', model: 'm', systemPrompt: 'x' }), 'opencode --model m');
});
