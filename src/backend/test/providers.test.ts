import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitArgs, buildOpenCodeArgs } from '../orchestrator/providers';

test('splitArgs splits on whitespace and drops empties', () => {
  assert.deepEqual(splitArgs('--agent build  --foo'), ['--agent', 'build', '--foo']);
  assert.deepEqual(splitArgs('--model=openrouter/x'), ['--model=openrouter/x']);
});

test('splitArgs tolerates null/empty', () => {
  assert.deepEqual(splitArgs(null), []);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('   '), []);
});

test('buildOpenCodeArgs runs with model + extra args before the prompt', () => {
  assert.deepEqual(
    buildOpenCodeArgs('openrouter/anthropic/claude-sonnet-4.5', '--agent build', 'hello world'),
    ['run', '--model', 'openrouter/anthropic/claude-sonnet-4.5', '--agent', 'build', 'hello world'],
  );
});

test('buildOpenCodeArgs omits --model when no model is given', () => {
  assert.deepEqual(buildOpenCodeArgs('', null, 'hi'), ['run', 'hi']);
  assert.deepEqual(buildOpenCodeArgs(undefined, undefined, 'hi'), ['run', 'hi']);
});
