import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Mission, MissionRun, MissionStopReason } from '@nexus/shared';
import { evaluateBounds, computeNextRunAt, isWithinRunWindow, clampToWindow } from './bounds.js';
import { getHandler } from './handlers/index.js';
import { getMission, updateMissionFields, insertMissionRun, completeMissionRun, claimDueMissions } from './store.js';
import type { MissionRunnerDeps, MissionRunContext } from './types.js';

function stopMission(db: Database.Database, mission: Mission, reason: MissionStopReason, now: Date): Mission {
  updateMissionFields(db, mission.id, {
    status: 'stopped', stop_reason: reason, stopped_at: now.toISOString(), next_run_at: null,
  });
  return getMission(db, mission.id)!;
}

/**
 * Run exactly one iteration of a mission:
 *  1. Re-check ceilings; if exceeded, stop the mission (no ledger row) and return.
 *  2. If outside the run window, reschedule to the window open (no ledger row).
 *  3. Open a ledger row, invoke the handler, record the result.
 *  4. Accumulate counters; decide stop vs. next_run_at.
 */
export async function runMissionOnce(
  db: Database.Database,
  mission: Mission,
  deps: MissionRunnerDeps,
): Promise<{ mission: Mission; run: MissionRun | null }> {
  const now = new Date();

  const bounds = evaluateBounds(mission, now);
  if (!bounds.allowed) {
    return { mission: stopMission(db, mission, bounds.stopReason!, now), run: null };
  }

  if (!isWithinRunWindow(mission, now)) {
    const nextAt = clampToWindow(now, mission).toISOString();
    updateMissionFields(db, mission.id, { next_run_at: nextAt });
    return { mission: getMission(db, mission.id)!, run: null };
  }

  const runNumber = mission.iteration_count + 1;
  const operationId = randomUUID();
  deps.emit?.({ type: 'start', operationId, kind: 'mission_tick', title: `Mission: ${mission.title}`, projectId: mission.project_id });

  const run = insertMissionRun(db, {
    mission_id: mission.id, run_number: runNumber, started_at: now.toISOString(),
    status: 'running', intent: '', selected_work_json: null,
  });

  const controller = new AbortController();
  const ctx: MissionRunContext = { db, mission, runNumber, signal: controller.signal, deps };

  let outcomeStatus: MissionRun['status'] = 'failed';
  let summary = '';
  let intent = '';
  let selectedWork: unknown = null;
  let tokensUsed = 0;
  let drained = false;
  let nextDelaySeconds: number | undefined;
  let error: string | null = null;

  try {
    const outcome = await getHandler(mission.kind)(ctx);
    outcomeStatus = outcome.status;
    summary = outcome.summary ?? '';
    intent = outcome.intent ?? '';
    selectedWork = outcome.selectedWork ?? null;
    tokensUsed = outcome.tokensUsed ?? 0;
    drained = outcome.drained ?? false;
    nextDelaySeconds = outcome.nextDelaySeconds;
    error = outcome.error ?? null;
  } catch (err) {
    outcomeStatus = 'failed';
    error = err instanceof Error ? err.message : String(err);
    summary = `handler threw: ${error}`;
  }

  const completedAt = new Date();

  // Accumulate counters on the mission.
  const newIterationCount = mission.iteration_count + 1;
  const newTokens = mission.tokens_used + tokensUsed;
  const updatedForBounds: Mission = {
    ...mission, iteration_count: newIterationCount, tokens_used: newTokens,
  };

  // Decide next step: drain -> stop; bounds reached -> stop; else schedule next.
  let stopReason: MissionStopReason | null = null;
  if (drained) {
    stopReason = 'drained';
  } else {
    const post = evaluateBounds(updatedForBounds, completedAt);
    if (!post.allowed) stopReason = post.stopReason!;
  }

  let nextRunAt: string | null = null;
  if (stopReason) {
    updateMissionFields(db, mission.id, {
      iteration_count: newIterationCount, tokens_used: newTokens, last_run_at: completedAt.toISOString(),
      status: 'stopped', stop_reason: stopReason, stopped_at: completedAt.toISOString(), next_run_at: null,
    });
  } else {
    nextRunAt = computeNextRunAt(updatedForBounds, { nextDelaySeconds }, completedAt);
    updateMissionFields(db, mission.id, {
      iteration_count: newIterationCount, tokens_used: newTokens, last_run_at: completedAt.toISOString(),
      next_run_at: nextRunAt,
    });
  }

  completeMissionRun(db, run.id, {
    completed_at: completedAt.toISOString(), status: outcomeStatus, intent,
    selected_work_json: selectedWork == null ? null : JSON.stringify(selectedWork),
    result_summary: summary, tokens_used: tokensUsed, error, next_run_at: nextRunAt, stop_reason: stopReason,
  });

  deps.emit?.({
    type: 'stop', operationId, kind: 'mission_tick', title: `Mission: ${mission.title}`,
    projectId: mission.project_id,
    status: outcomeStatus === 'succeeded' ? 'succeeded' : 'failed',
    error: error ?? undefined,
    diagnostics: { runNumber, stopReason, tokensUsed, summary },
  });

  const finalMission = getMission(db, mission.id)!;
  const finalRun = db.prepare('SELECT * FROM mission_runs WHERE id = ?').get(run.id) as MissionRun;
  return { mission: finalMission, run: finalRun };
}

const DEFAULT_TICK_MS = 5_000;

/**
 * Single in-process scheduler. Each tick claims due active missions (by persisted
 * next_run_at) and runs them. An in-memory guard prevents a mission from overlapping
 * itself if an iteration runs longer than the tick interval. Restart-safe: due-ness
 * lives in the DB, so a backend restart resumes from next_run_at.
 */
export function startMissionScheduler(
  db: Database.Database,
  deps: MissionRunnerDeps,
  opts: { tickMs?: number } = {},
): { stop: () => void } {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const running = new Set<string>();
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let due: Mission[] = [];
    try {
      due = claimDueMissions(db, new Date().toISOString());
    } catch (err) {
      console.error('[missions] failed to query due missions:', err);
      return;
    }
    for (const mission of due) {
      if (running.has(mission.id)) continue;
      running.add(mission.id);
      void runMissionOnce(db, mission, deps)
        .catch((err) => console.error(`[missions] mission ${mission.id} crashed:`, err))
        .finally(() => running.delete(mission.id));
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), tickMs);
  console.log(`[missions] scheduler started — tick ${tickMs}ms`);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
