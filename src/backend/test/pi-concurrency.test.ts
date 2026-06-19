import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTracker } from '../pi/concurrency';

test('ConcurrencyTracker.claim + get round-trip', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claim('project-a', 'anthropic/sonnet', 'thread-1', 'My thread'));
  const got = t.get('project-a', 'anthropic/sonnet');
  assert.deepEqual(got, { threadId: 'thread-1', title: 'My thread', modelKey: 'anthropic/sonnet' });
});

test('ConcurrencyTracker.get returns undefined for unknown project', () => {
  const t = new ConcurrencyTracker();
  assert.equal(t.get('nope', 'anthropic/sonnet'), undefined);
});

test('ConcurrencyTracker.release removes a project+model slot', () => {
  const t = new ConcurrencyTracker();
  const owner = t.claim('project-a', 'anthropic/sonnet', 'thread-1', 'T');
  assert.ok(owner);
  t.release('project-a', 'anthropic/sonnet', owner);
  assert.equal(t.get('project-a', 'anthropic/sonnet'), undefined);
});

test('ConcurrencyTracker rejects a second claim for the same project+model', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claim('project-a', 'anthropic/sonnet', 'thread-1', 'A'));
  assert.equal(t.claim('project-a', 'anthropic/sonnet', 'thread-2', 'B'), undefined);
  assert.deepEqual(t.get('project-a', 'anthropic/sonnet'), {
    threadId: 'thread-1',
    title: 'A',
    modelKey: 'anthropic/sonnet',
  });
});

test('ConcurrencyTracker.isolates projects and models', () => {
  const t = new ConcurrencyTracker();
  t.claim('project-a', 'anthropic/sonnet', 'thread-1', 'A');
  t.claim('project-a', 'openai/gpt-5', 'thread-2', 'B');
  t.claim('project-b', 'anthropic/sonnet', 'thread-3', 'C');
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

test('ConcurrencyTracker stale owner cannot release a replacement claim', () => {
  const t = new ConcurrencyTracker();
  const firstOwner = t.claim('project-a', 'anthropic/sonnet', 'thread-1', 'A');
  assert.ok(firstOwner);
  assert.equal(t.release('project-a', 'anthropic/sonnet', firstOwner), true);

  const replacementOwner = t.claim('project-a', 'anthropic/sonnet', 'thread-2', 'B');
  assert.ok(replacementOwner);
  assert.equal(t.release('project-a', 'anthropic/sonnet', firstOwner), false);
  assert.deepEqual(t.get('project-a', 'anthropic/sonnet'), {
    threadId: 'thread-2',
    title: 'B',
    modelKey: 'anthropic/sonnet',
  });
  assert.equal(t.claim('project-a', 'anthropic/sonnet', 'thread-3', 'C'), undefined);
});
