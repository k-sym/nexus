import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTracker } from '../pi/concurrency';

test('ConcurrencyTracker.set + get round-trip', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'thread-1', 'My thread');
  const got = t.get('project-a');
  assert.deepEqual(got, { threadId: 'thread-1', title: 'My thread' });
});

test('ConcurrencyTracker.get returns undefined for unknown project', () => {
  const t = new ConcurrencyTracker();
  assert.equal(t.get('nope'), undefined);
});

test('ConcurrencyTracker.clear removes a project', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'thread-1', 'T');
  t.clear('project-a');
  assert.equal(t.get('project-a'), undefined);
});

test('ConcurrencyTracker.overwrite when a new thread starts in the same project', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'thread-1', 'A');
  t.set('project-a', 'thread-2', 'B');
  assert.deepEqual(t.get('project-a'), { threadId: 'thread-2', title: 'B' });
});

test('ConcurrencyTracker.isolates projects', () => {
  const t = new ConcurrencyTracker();
  t.set('project-a', 'thread-1', 'A');
  t.set('project-b', 'thread-2', 'B');
  assert.deepEqual(t.get('project-a'), { threadId: 'thread-1', title: 'A' });
  assert.deepEqual(t.get('project-b'), { threadId: 'thread-2', title: 'B' });
});
