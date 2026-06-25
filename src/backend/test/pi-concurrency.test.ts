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

// ── Project-wide claims (issue #95) ─────────────────────────────────────────

test('ConcurrencyTracker.claimProject + getProject round-trip', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'Mission A'));
  const got = t.getProject('project-a');
  assert.deepEqual(got, { threadId: 'thread-1', title: 'Mission A', scope: 'project' });
});

test('ConcurrencyTracker.getProject returns undefined for unknown project', () => {
  const t = new ConcurrencyTracker();
  assert.equal(t.getProject('nope'), undefined);
});

test('ConcurrencyTracker.releaseProject removes the project slot', () => {
  const t = new ConcurrencyTracker();
  const owner = t.claimProject('project-a', 'thread-1', 'Mission');
  assert.ok(owner);
  t.releaseProject('project-a', owner);
  assert.equal(t.getProject('project-a'), undefined);
});

test('ConcurrencyTracker rejects a second project-wide claim on the same project', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'Mission'));
  assert.equal(t.claimProject('project-a', 'thread-2', 'Other'), undefined);
  assert.equal(t.getProject('project-a')?.threadId, 'thread-1');
});

test('ConcurrencyTracker project-wide claim is independent of per-(project,model) slots', () => {
  const t = new ConcurrencyTracker();
  // A mission holds the project-wide slot...
  assert.ok(t.claimProject('project-a', 'mission-thread', 'Mission'));
  // ...and a per-model claim for the SAME project but a DIFFERENT thread still
  // succeeds at the tracker level (chat enforces mutual exclusion at the
  // route layer, not the primitive). This proves the maps are independent.
  assert.ok(t.claim('project-a', 'anthropic/sonnet', 'chat-thread', 'Chat'));
  assert.equal(t.getProject('project-a')?.threadId, 'mission-thread');
  assert.equal(t.get('project-a', 'anthropic/sonnet')?.threadId, 'chat-thread');
});

test('ConcurrencyTracker project-wide claim is isolated per project', () => {
  const t = new ConcurrencyTracker();
  assert.ok(t.claimProject('project-a', 'thread-1', 'A'));
  assert.ok(t.claimProject('project-b', 'thread-2', 'B'));
  assert.equal(t.getProject('project-a')?.threadId, 'thread-1');
  assert.equal(t.getProject('project-b')?.threadId, 'thread-2');
});

test('ConcurrencyTracker stale owner cannot releaseProject a replacement', () => {
  const t = new ConcurrencyTracker();
  const first = t.claimProject('project-a', 'thread-1', 'A');
  assert.ok(first);
  t.releaseProject('project-a', first);
  const second = t.claimProject('project-a', 'thread-2', 'B');
  assert.ok(second);
  assert.equal(t.releaseProject('project-a', first), false);
  assert.equal(t.getProject('project-a')?.threadId, 'thread-2');
});

test('ConcurrencyTracker.releaseProject wakes waitForProjectRelease waiters', async () => {
  const t = new ConcurrencyTracker();
  const owner = t.claimProject('project-a', 'thread-1', 'Mission');
  assert.ok(owner);
  const observed = t.getProject('project-a')!;
  const released = t.waitForProjectRelease('project-a', observed, 1000);
  // Release shortly; the waiter should resolve to true before the timeout.
  setTimeout(() => t.releaseProject('project-a', owner), 5);
  assert.equal(await released, true);
  assert.equal(t.getProject('project-a'), undefined);
});

test('ConcurrencyTracker.waitForProjectRelease resolves immediately when not held', async () => {
  const t = new ConcurrencyTracker();
  const observed = { threadId: 'gone', title: 'gone', scope: 'project' as const };
  assert.equal(await t.waitForProjectRelease('project-a', observed, 100), true);
});
