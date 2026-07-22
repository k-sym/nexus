import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRollup, formatRollupText, formatRollupPercent } from '../monday/rollup';

test('computeRollup buckets the five Kanban columns', () => {
  const counts = computeRollup(['triage', 'todo', 'in_progress', 'review', 'deploy']);
  assert.deepEqual(counts, { total: 5, open: 2, inProgress: 1, inReview: 1, done: 1 });
});

test('only deploy counts as done', () => {
  assert.equal(computeRollup(['review', 'review']).done, 0);
  assert.equal(computeRollup(['deploy', 'deploy']).done, 2);
});

test('formatRollupText always leads with done/total', () => {
  assert.equal(formatRollupText(computeRollup(['deploy', 'todo'])), '1/2 done');
});

test('formatRollupText appends review and progress only when non-zero', () => {
  assert.equal(
    formatRollupText(computeRollup(['deploy', 'deploy', 'deploy', 'review', 'in_progress'])),
    '3/5 done · 1 in review · 1 in progress',
  );
  assert.equal(formatRollupText(computeRollup(['deploy', 'review'])), '1/2 done · 1 in review');
  assert.equal(formatRollupText(computeRollup(['deploy', 'in_progress'])), '1/2 done · 1 in progress');
});

test('formatRollupText reports an empty link set distinctly', () => {
  assert.equal(formatRollupText(computeRollup([])), 'no linked tasks');
});

test('formatRollupPercent is done over total, rounded', () => {
  assert.equal(formatRollupPercent(computeRollup([])), 0);
  assert.equal(formatRollupPercent(computeRollup(['deploy', 'deploy', 'todo'])), 67);
  assert.equal(formatRollupPercent(computeRollup(['review', 'review'])), 0);
  assert.equal(formatRollupPercent(computeRollup(['deploy'])), 100);
});
