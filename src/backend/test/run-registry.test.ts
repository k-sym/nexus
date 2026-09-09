import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { markRunning, markStopped, isRunning, runningThreadIds, onRunChange, __resetRunRegistry } from '../chat/run-registry';

beforeEach(() => __resetRunRegistry());

test('marks, lists and forgets running threads', () => {
  markRunning('t1', { title: 'One', modelKey: 'm' });
  assert.equal(isRunning('t1'), true);
  assert.deepEqual([...runningThreadIds()], ['t1']);
  markStopped('t1');
  assert.equal(isRunning('t1'), false);
  assert.equal(runningThreadIds().size, 0);
});

test('listeners see start and stop once each; stopping an unknown thread is silent', () => {
  const seen: Array<[string, boolean]> = [];
  const off = onRunChange((id, running) => seen.push([id, running]));
  markRunning('t1', { title: 'One', modelKey: 'm' });
  markStopped('t1');
  markStopped('t1');
  markStopped('never');
  off();
  markRunning('t2', { title: 'Two', modelKey: 'm' });
  assert.deepEqual(seen, [['t1', true], ['t1', false]]);
});

test('a throwing listener does not break the others', () => {
  let count = 0;
  onRunChange(() => { throw new Error('boom'); });
  onRunChange(() => { count++; });
  markRunning('t1', { title: 'One', modelKey: 'm' });
  assert.equal(count, 1);
});
