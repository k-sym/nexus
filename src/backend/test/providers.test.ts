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

import { hermesHealthUrl } from '../orchestrator/providers';

test('hermesHealthUrl derives /health from a /v1 base', () => {
  assert.equal(hermesHealthUrl('http://100.87.109.31:8642/v1'), 'http://100.87.109.31:8642/health');
  assert.equal(hermesHealthUrl('http://100.87.109.31:8642/v1/'), 'http://100.87.109.31:8642/health');
  assert.equal(hermesHealthUrl('http://h:8642'), 'http://h:8642/health');
});
