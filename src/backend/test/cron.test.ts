import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, isValidCron, getNextRun } from '../scheduler/cron';

test('parseCron expands wildcards and steps', () => {
  const fields = parseCron('*/15 * * * *');
  assert.ok(fields);
  assert.deepEqual(fields!.minute, [0, 15, 30, 45]);
  assert.equal(fields!.hour.length, 24);
});

test('parseCron handles lists and ranges', () => {
  const fields = parseCron('0 9 * * 1-5');
  assert.ok(fields);
  assert.deepEqual(fields!.minute, [0]);
  assert.deepEqual(fields!.hour, [9]);
  assert.deepEqual(fields!.dayOfWeek, [1, 2, 3, 4, 5]);
});

test('isValidCron rejects wrong field count', () => {
  assert.equal(isValidCron('* * * *'), false);
  assert.equal(isValidCron('* * * * * *'), false);
});

test('isValidCron rejects non-numeric and out-of-range fields', () => {
  assert.equal(isValidCron('abc * * * *'), false);
  assert.equal(isValidCron('99 * * * *'), false);
  assert.equal(isValidCron('0 9 * * 1-5'), true);
});

test('getNextRun finds the next matching minute', () => {
  const from = new Date('2026-01-01T08:30:00Z');
  // Use UTC-based expectation by checking the returned date matches the cron.
  const next = getNextRun('0 9 * * *', from);
  assert.ok(next);
  assert.equal(next!.getHours(), 9);
  assert.equal(next!.getMinutes(), 0);
  assert.ok(next!.getTime() > from.getTime());
});

test('getNextRun returns a strictly future time', () => {
  const from = new Date('2026-03-15T12:00:00');
  const next = getNextRun('* * * * *', from);
  assert.ok(next);
  assert.equal(next!.getTime(), from.getTime() + 60_000);
});
