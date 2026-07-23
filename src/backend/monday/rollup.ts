/**
 * Pure roll-up computation: linked task statuses → the value written to the
 * project's configured Monday column.
 *
 * Deploy is the only bucket that counts as done, so a numeric column reads 0
 * until work actually reaches Deploy. Review is broken out separately because
 * it is the state a human most often wants to act on.
 */
import { MONDAY_ROLLUP_BUCKETS, type TaskStatus } from '@nexus/shared';

export interface RollupCounts {
  total: number;
  open: number;
  inProgress: number;
  inReview: number;
  done: number;
}

export function computeRollup(statuses: TaskStatus[]): RollupCounts {
  const counts: RollupCounts = { total: statuses.length, open: 0, inProgress: 0, inReview: 0, done: 0 };
  for (const status of statuses) {
    counts[MONDAY_ROLLUP_BUCKETS[status]] += 1;
  }
  return counts;
}

export function formatRollupText(counts: RollupCounts): string {
  if (counts.total === 0) return 'no linked tasks';
  const parts = [`${counts.done}/${counts.total} done`];
  if (counts.inReview > 0) parts.push(`${counts.inReview} in review`);
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
  return parts.join(' · ');
}

export function formatRollupPercent(counts: RollupCounts): number {
  if (counts.total === 0) return 0;
  return Math.round((counts.done / counts.total) * 100);
}
