import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBounds, isWithinRunWindow, clampToWindow, computeNextRunAt,
} from '../missions/bounds';
import type { Mission } from '@nexus/shared';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1', project_id: 'p1', title: 't', description: '', kind: 'echo',
    config_json: '{}', pacing: 'fixed', interval_seconds: 3600,
    max_iterations: null, max_wall_clock_seconds: null, max_tokens: null,
    run_window_start: null, run_window_end: null, status: 'active',
    iteration_count: 0, tokens_used: 0, next_run_at: null,
    started_at: '2026-06-22T00:00:00.000Z', last_run_at: null,
    stopped_at: null, stop_reason: null,
    created_at: '2026-06-22T00:00:00.000Z', updated_at: '2026-06-22T00:00:00.000Z',
    ...overrides,
  };
}

test('evaluateBounds stops on max_iterations reached', () => {
  const m = mission({ max_iterations: 3, iteration_count: 3 });
  assert.deepEqual(evaluateBounds(m, new Date('2026-06-22T01:00:00Z')), { allowed: false, stopReason: 'max_iterations' });
});

test('evaluateBounds allows when under all ceilings', () => {
  const m = mission({ max_iterations: 3, iteration_count: 1 });
  assert.deepEqual(evaluateBounds(m, new Date('2026-06-22T01:00:00Z')), { allowed: true });
});

test('evaluateBounds stops on wall-clock budget exceeded', () => {
  const m = mission({ max_wall_clock_seconds: 60, started_at: '2026-06-22T00:00:00.000Z' });
  assert.deepEqual(evaluateBounds(m, new Date('2026-06-22T00:02:00Z')), { allowed: false, stopReason: 'max_wall_clock' });
});

test('evaluateBounds stops on token budget exceeded', () => {
  const m = mission({ max_tokens: 1000, tokens_used: 1000 });
  assert.deepEqual(evaluateBounds(m, new Date('2026-06-22T00:01:00Z')), { allowed: false, stopReason: 'token_budget' });
});

test('isWithinRunWindow handles a normal daytime window', () => {
  const m = mission({ run_window_start: '09:00', run_window_end: '17:00' });
  assert.equal(isWithinRunWindow(m, new Date('2026-06-22T12:00:00')), true);
  assert.equal(isWithinRunWindow(m, new Date('2026-06-22T18:00:00')), false);
});

test('isWithinRunWindow handles an overnight window that wraps midnight', () => {
  const m = mission({ run_window_start: '22:00', run_window_end: '06:00' });
  assert.equal(isWithinRunWindow(m, new Date('2026-06-22T23:30:00')), true);
  assert.equal(isWithinRunWindow(m, new Date('2026-06-22T03:00:00')), true);
  assert.equal(isWithinRunWindow(m, new Date('2026-06-22T12:00:00')), false);
});

test('isWithinRunWindow is always true when no window configured', () => {
  assert.equal(isWithinRunWindow(mission(), new Date('2026-06-22T12:00:00')), true);
});

test('computeNextRunAt for fixed pacing adds interval_seconds', () => {
  const m = mission({ interval_seconds: 600 });
  assert.equal(computeNextRunAt(m, {}, new Date('2026-06-22T00:00:00.000Z')), '2026-06-22T00:10:00.000Z');
});

test('computeNextRunAt for self_paced uses outcome.nextDelaySeconds', () => {
  const m = mission({ pacing: 'self_paced', interval_seconds: 600 });
  assert.equal(computeNextRunAt(m, { nextDelaySeconds: 30 }, new Date('2026-06-22T00:00:00.000Z')), '2026-06-22T00:00:30.000Z');
});

test('clampToWindow pushes an out-of-window time to the next window open', () => {
  const m = mission({ run_window_start: '22:00', run_window_end: '06:00' });
  // noon local -> next open is 22:00 same day
  const clamped = clampToWindow(new Date('2026-06-22T12:00:00'), m);
  assert.equal(clamped.getHours(), 22);
  assert.equal(clamped.getMinutes(), 0);
});
