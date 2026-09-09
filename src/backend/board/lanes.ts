/**
 * Lane derivation for the session-first board (#439). Pure: the board route
 * and the Monday roll-up both call this with facts they already hold, so the
 * two can never disagree about which lane a thread is in.
 */
import type { BoardCardLane, TaskStatus } from '@nexus/shared';

export interface LaneInput {
  archived_at: string | null | undefined;
  running: boolean;
  pending_questions: number;
  pending_approvals: number;
}

/** Done beats everything (an archived thread cannot run); then a run that is
 *  waiting on Keith; then a run; else idle. */
export function deriveLane(input: LaneInput): BoardCardLane {
  if (input.archived_at) return 'done';
  if (input.running && (input.pending_questions > 0 || input.pending_approvals > 0)) return 'needs_you';
  if (input.running) return 'running';
  return 'idle';
}

/** The legacy column a lane projects onto, so the Monday roll-up buckets and
 *  status mapping (both keyed by `TaskStatus`) keep working unchanged:
 *  Running and Needs you are in progress, Idle is in review, Done is deploy.
 *  Inbox has no thread and never reaches here. */
export function laneToTaskStatus(lane: BoardCardLane): TaskStatus {
  switch (lane) {
    case 'running':
    case 'needs_you':
      return 'in_progress';
    case 'idle':
      return 'review';
    case 'done':
      return 'deploy';
  }
}

/** Days an archived thread stays on the board as Done before its origin may
 *  return to the Inbox. */
export const DONE_WINDOW_DAYS = 30;

export function doneWindowStart(now: Date = new Date()): string {
  return new Date(now.getTime() - DONE_WINDOW_DAYS * 86_400_000).toISOString();
}
