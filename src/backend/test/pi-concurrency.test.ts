import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTracker } from '../pi/concurrency';

test('ConcurrencyTracker.set + get round-trip', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'anthropic/sonnet', 'thread-1', 'My thread');
  const got = t.get('project-a', 'anthropic/sonnet');
  assert.deepEqual(got, { threadId: 'thread-1', title: 'My thread', modelKey: 'anthropic/sonnet' });
});

test('ConcurrencyTracker.get returns undefined for unknown project', () => {
  const t = new ConcurrencyTracker();
  assert.equal(t.get('nope', 'anthropic/sonnet'), undefined);
});

test('ConcurrencyTracker.clear removes a project+model slot', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'anthropic/sonnet', 'thread-1', 'T');
  t.clear('project-a', 'anthropic/sonnet');
  assert.equal(t.get('project-a', 'anthropic/sonnet'), undefined);
});

test('ConcurrencyTracker.overwrite when a new thread starts with the same project+model', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'anthropic/sonnet', 'thread-1', 'A');
  t.set('project-a', 'anthropic/sonnet', 'thread-2', 'B');
  assert.deepEqual(t.get('project-a', 'anthropic/sonnet'), {
    threadId: 'thread-2',
    title: 'B',
    modelKey: 'anthropic/sonnet',
  });
});

test('ConcurrencyTracker.isolates projects and models', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'anthropic/sonnet', 'thread-1', 'A');
  t.set('project-a', 'openai/gpt-5', 'thread-2', 'B');
  t.set('project-b', 'anthropic/sonnet', 'thread-3', 'C');
  assert.deepEqual(t.get('project-a', 'anthropic/sonnet'), {
    threadId: 'thread-1',
    title: 'A',
    modelKey: 'anthropic/sonnet',
  });
  assert.deepEqual(t.get('project-a', 'openai/gpt-5'), {
    threadId: 'thread-2',
    title: 'B',
    modelKey: 'openai/gpt-5',
  });
  assert.deepEqual(t.get('project-b', 'anthropic/sonnet'), {
    threadId: 'thread-3',
    title: 'C',
    modelKey: 'anthropic/sonnet',
  });
});
