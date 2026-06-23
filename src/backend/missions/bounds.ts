import type { Mission, MissionStopReason } from '@nexus/shared';

export interface BoundsResult {
  allowed: boolean;
  stopReason?: MissionStopReason;
}

/** Evaluated BEFORE each iteration and again after, against current counters. */
export function evaluateBounds(mission: Mission, now: Date): BoundsResult {
  if (mission.max_iterations != null && mission.iteration_count >= mission.max_iterations) {
    return { allowed: false, stopReason: 'max_iterations' };
  }
  if (mission.max_wall_clock_seconds != null && mission.started_at) {
    const elapsedSec = (now.getTime() - new Date(mission.started_at).getTime()) / 1000;
    if (elapsedSec >= mission.max_wall_clock_seconds) {
      return { allowed: false, stopReason: 'max_wall_clock' };
    }
  }
  if (mission.max_tokens != null && mission.tokens_used >= mission.max_tokens) {
    return { allowed: false, stopReason: 'token_budget' };
  }
  return { allowed: true };
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

/** Local-time run window. Empty window => always open. Supports windows that wrap midnight. */
export function isWithinRunWindow(mission: Mission, now: Date): boolean {
  if (!mission.run_window_start || !mission.run_window_end) return true;
  const start = parseHHMM(mission.run_window_start);
  const end = parseHHMM(mission.run_window_end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  // wraps midnight
  return cur >= start || cur < end;
}

/** If `at` falls outside the run window, return the next window-open instant >= at. */
export function clampToWindow(at: Date, mission: Mission): Date {
  if (!mission.run_window_start || !mission.run_window_end) return at;
  if (isWithinRunWindow(mission, at)) return at;
  const start = parseHHMM(mission.run_window_start);
  const open = new Date(at);
  open.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (open.getTime() <= at.getTime()) open.setDate(open.getDate() + 1);
  return open;
}

export function nextIntervalSeconds(mission: Mission, outcome: { nextDelaySeconds?: number }): number {
  if (mission.pacing === 'self_paced' && typeof outcome.nextDelaySeconds === 'number') {
    return Math.max(1, outcome.nextDelaySeconds);
  }
  return Math.max(1, mission.interval_seconds);
}

export function computeNextRunAt(mission: Mission, outcome: { nextDelaySeconds?: number }, now: Date): string {
  const delaySec = nextIntervalSeconds(mission, outcome);
  const naive = new Date(now.getTime() + delaySec * 1000);
  return clampToWindow(naive, mission).toISOString();
}
