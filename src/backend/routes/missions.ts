import type { FastifyInstance } from 'fastify';
import type { CreateMissionInput, MissionPacing, MissionKind } from '@nexus/shared';
import {
  insertMission, getMission, listMissionsForProject, updateMissionFields, deleteMission,
} from '../missions/store.js';

const VALID_KINDS: MissionKind[] = ['echo', 'triage_tickets', 'review_stale_tasks', 'assistant_turn'];
const VALID_PACING: MissionPacing[] = ['fixed', 'self_paced', 'backlog_drain'];

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** A mission must have a terminating ceiling: a count/time cap, or backlog_drain pacing. */
function assertBounded(body: CreateMissionInput): void {
  const hasCap = (body.max_iterations != null && body.max_iterations > 0)
    || (body.max_wall_clock_seconds != null && body.max_wall_clock_seconds > 0);
  if (body.pacing !== 'backlog_drain' && !hasCap) {
    throw httpError('mission requires max_iterations, max_wall_clock_seconds, or backlog_drain pacing', 400);
  }
}

function validateCommon(body: CreateMissionInput): void {
  if (body.kind && !VALID_KINDS.includes(body.kind)) throw httpError(`invalid kind '${body.kind}'`, 400);
  if (body.pacing && !VALID_PACING.includes(body.pacing)) throw httpError(`invalid pacing '${body.pacing}'`, 400);
  for (const w of [body.run_window_start, body.run_window_end]) {
    if (w != null && !/^\d{2}:\d{2}$/.test(w)) throw httpError(`run window must be HH:MM, got '${w}'`, 400);
  }
}

export async function registerMissionRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/projects/:projectId/missions', async (request) => {
    const { projectId } = request.params as { projectId: string };
    return listMissionsForProject(db, projectId);
  });

  fastify.post('/api/projects/:projectId/missions', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) throw httpError('project not found', 404);

    const body = (request.body ?? {}) as CreateMissionInput;
    const title = (body.title ?? '').trim();
    if (!title) throw httpError('title is required', 400);
    validateCommon(body);
    assertBounded(body);

    return insertMission(db, {
      project_id: projectId,
      title,
      description: body.description ?? '',
      kind: body.kind ?? 'echo',
      config_json: JSON.stringify(body.config ?? {}),
      pacing: body.pacing ?? 'fixed',
      interval_seconds: body.interval_seconds ?? 3600,
      max_iterations: body.max_iterations ?? null,
      max_wall_clock_seconds: body.max_wall_clock_seconds ?? null,
      max_tokens: body.max_tokens ?? null,
      run_window_start: body.run_window_start ?? null,
      run_window_end: body.run_window_end ?? null,
      status: 'paused',
      next_run_at: null,
      started_at: null,
    });
  });

  fastify.get('/api/missions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const mission = getMission(db, id);
    if (!mission) throw httpError('mission not found', 404);
    return mission;
  });

  fastify.put('/api/missions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const mission = getMission(db, id);
    if (!mission) throw httpError('mission not found', 404);
    if (mission.status !== 'paused') throw httpError('mission must be paused to edit', 409);

    const body = (request.body ?? {}) as CreateMissionInput;
    validateCommon(body);
    const merged: CreateMissionInput = {
      title: body.title ?? mission.title,
      pacing: body.pacing ?? mission.pacing,
      interval_seconds: body.interval_seconds ?? mission.interval_seconds,
      max_iterations: body.max_iterations !== undefined ? body.max_iterations : mission.max_iterations,
      max_wall_clock_seconds: body.max_wall_clock_seconds !== undefined ? body.max_wall_clock_seconds : mission.max_wall_clock_seconds,
    };
    assertBounded(merged);

    const fields: Record<string, unknown> = {};
    if (body.title !== undefined) fields.title = body.title.trim();
    if (body.description !== undefined) fields.description = body.description;
    if (body.kind !== undefined) fields.kind = body.kind;
    if (body.config !== undefined) fields.config_json = JSON.stringify(body.config);
    if (body.pacing !== undefined) fields.pacing = body.pacing;
    if (body.interval_seconds !== undefined) fields.interval_seconds = body.interval_seconds;
    if (body.max_iterations !== undefined) fields.max_iterations = body.max_iterations;
    if (body.max_wall_clock_seconds !== undefined) fields.max_wall_clock_seconds = body.max_wall_clock_seconds;
    if (body.max_tokens !== undefined) fields.max_tokens = body.max_tokens;
    if (body.run_window_start !== undefined) fields.run_window_start = body.run_window_start;
    if (body.run_window_end !== undefined) fields.run_window_end = body.run_window_end;
    updateMissionFields(db, id, fields as never);
    return getMission(db, id)!;
  });

  fastify.delete('/api/missions/:id', async (request) => {
    const { id } = request.params as { id: string };
    deleteMission(db, id);
    return { success: true };
  });
}
