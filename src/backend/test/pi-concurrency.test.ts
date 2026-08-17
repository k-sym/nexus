import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTracker } from '../pi/concurrency';

test('ConcurrencyTracker.claimProject + getProject round-trip for a chat run', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'Chat A', 'chat', 'anthropic/sonnet'));
  assert.deepEqual(t.getProject('project-a'), {
    threadId: 'thread-1',
    title: 'Chat A',
    scope: 'project',
    source: 'chat',
    modelKey: 'anthropic/sonnet',
  });
});

test('ConcurrencyTracker.claimProject + getProject round-trip without a modelKey', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'Chat A', 'chat'));
  assert.deepEqual(t.getProject('project-a'), {
    threadId: 'thread-1',
    title: 'Chat A',
    scope: 'project',
    source: 'chat',
  });
});

test('ConcurrencyTracker.getProject returns undefined for an unknown project', () => {
  const t = new ConcurrencyTracker();
  assert.equal(t.getProject('nope'), undefined);
});

test('ConcurrencyTracker rejects a second run in the same project regardless of model', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'A', 'chat', 'anthropic/sonnet'));
  assert.equal(
    t.claimProject('project-a', 'thread-2', 'B', 'chat', 'openai/gpt-5'),
    undefined,
  );
  assert.equal(t.getProject('project-a')?.threadId, 'thread-1');
});

test('ConcurrencyTracker isolates project working-tree claims', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'A', 'chat', 'anthropic/sonnet'));
  assert.ok(t.claimProject('project-b', 'thread-2', 'B', 'chat', 'anthropic/sonnet'));
  assert.equal(t.getProject('project-a')?.threadId, 'thread-1');
  assert.equal(t.getProject('project-b')?.threadId, 'thread-2');
});

test('ConcurrencyTracker.releaseProject removes the project slot', () => {
  const t = new ConcurrencyTracker();
  const owner = t.claimProject('project-a', 'thread-1', 'A', 'chat');
  assert.ok(owner);
  assert.equal(t.releaseProject('project-a', owner), true);
  assert.equal(t.getProject('project-a'), undefined);
});

test('ConcurrencyTracker stale owner cannot release a replacement claim', () => {
  const t = new ConcurrencyTracker();
  const first = t.claimProject('project-a', 'thread-1', 'A', 'chat', 'anthropic/sonnet');
  assert.ok(first);
  assert.equal(t.releaseProject('project-a', first), true);

  const second = t.claimProject('project-a', 'thread-2', 'B', 'chat', 'openai/gpt-5');
  assert.ok(second);
  assert.equal(t.releaseProject('project-a', first), false);
  assert.equal(t.getProject('project-a')?.threadId, 'thread-2');
});

test('ConcurrencyTracker.releaseProject wakes waitForProjectRelease waiters', async () => {
  const t = new ConcurrencyTracker();
  const owner = t.claimProject('project-a', 'thread-1', 'A', 'chat');
  assert.ok(owner);
  const observed = t.getProject('project-a')!;
  const released = t.waitForProjectRelease('project-a', observed, 1000);
  setTimeout(() => t.releaseProject('project-a', owner), 5);
  assert.equal(await released, true);
  assert.equal(t.getProject('project-a'), undefined);
});

test('ConcurrencyTracker.waitForProjectRelease resolves immediately when not held', async () => {
  const t = new ConcurrencyTracker();
  const observed = {
    threadId: 'gone',
    title: 'gone',
    scope: 'project' as const,
    source: 'chat' as const,
  };
  assert.equal(await t.waitForProjectRelease('project-a', observed, 100), true);
});
