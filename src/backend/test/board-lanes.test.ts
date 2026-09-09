import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLane, laneToTaskStatus, doneWindowStart } from '../board/lanes';

test('deriveLane: archived wins, then needs_you, then running, else idle', () => {
  assert.equal(deriveLane({ archived_at: '2026-09-01T00:00:00Z', running: true, pending_questions: 1, pending_approvals: 0 }), 'done');
  assert.equal(deriveLane({ archived_at: null, running: true, pending_questions: 1, pending_approvals: 0 }), 'needs_you');
  assert.equal(deriveLane({ archived_at: null, running: true, pending_questions: 0, pending_approvals: 2 }), 'needs_you');
  assert.equal(deriveLane({ archived_at: null, running: true, pending_questions: 0, pending_approvals: 0 }), 'running');
  assert.equal(deriveLane({ archived_at: undefined, running: false, pending_questions: 0, pending_approvals: 0 }), 'idle');
  // A pending gate without a run is stale state, not a lane: idle.
  assert.equal(deriveLane({ archived_at: null, running: false, pending_questions: 1, pending_approvals: 0 }), 'idle');
});

test('laneToTaskStatus projects lanes onto the Monday vocabulary', () => {
  assert.equal(laneToTaskStatus('running'), 'in_progress');
  assert.equal(laneToTaskStatus('needs_you'), 'in_progress');
  assert.equal(laneToTaskStatus('idle'), 'review');
  assert.equal(laneToTaskStatus('done'), 'deploy');
});

test('doneWindowStart is 30 days before now', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');
  assert.equal(doneWindowStart(now), '2026-08-10T12:00:00.000Z');
});
