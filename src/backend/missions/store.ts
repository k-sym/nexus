import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Mission, MissionRun } from '@nexus/shared';

export interface NewMissionRow {
  project_id: string;
  title: string;
  description: string;
  kind: Mission['kind'];
  config_json: string;
  pacing: Mission['pacing'];
  interval_seconds: number;
  max_iterations: number | null;
  max_wall_clock_seconds: number | null;
  max_tokens: number | null;
  run_window_start: string | null;
  run_window_end: string | null;
  status: Mission['status'];
  next_run_at: string | null;
  started_at: string | null;
}

export function insertMission(db: Database.Database, input: NewMissionRow): Mission {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO missions (
      id, project_id, title, description, kind, config_json, pacing, interval_seconds,
      max_iterations, max_wall_clock_seconds, max_tokens, run_window_start, run_window_end,
      status, iteration_count, tokens_used, next_run_at, started_at, last_run_at,
      stopped_at, stop_reason, created_at, updated_at
    ) VALUES (
      @id, @project_id, @title, @description, @kind, @config_json, @pacing, @interval_seconds,
      @max_iterations, @max_wall_clock_seconds, @max_tokens, @run_window_start, @run_window_end,
      @status, 0, 0, @next_run_at, @started_at, NULL, NULL, NULL, @now, @now
    )
  `).run({ id, now, ...input });
  return getMission(db, id)!;
}

export function getMission(db: Database.Database, id: string): Mission | undefined {
  return db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Mission | undefined;
}

export function listMissionsForProject(db: Database.Database, projectId: string): Mission[] {
  return db.prepare('SELECT * FROM missions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Mission[];
}

export function listAllMissions(db: Database.Database): Mission[] {
  return db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all() as Mission[];
}

export function updateMissionFields(db: Database.Database, id: string, fields: Partial<Mission>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE missions SET ${set}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: new Date().toISOString() });
}

export function deleteMission(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM missions WHERE id = ?').run(id);
}

export interface NewMissionRunRow {
  mission_id: string;
  run_number: number;
  started_at: string;
  status: MissionRun['status'];
  intent: string;
  selected_work_json: string | null;
}

export function insertMissionRun(db: Database.Database, row: NewMissionRunRow): MissionRun {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO mission_runs (
      id, mission_id, run_number, started_at, completed_at, status, intent,
      selected_work_json, result_summary, tokens_used, error, next_run_at, stop_reason, created_at
    ) VALUES (@id, @mission_id, @run_number, @started_at, NULL, @status, @intent,
      @selected_work_json, '', 0, NULL, NULL, NULL, @now)
  `).run({ id, now, ...row });
  return db.prepare('SELECT * FROM mission_runs WHERE id = ?').get(id) as MissionRun;
}

export function completeMissionRun(db: Database.Database, id: string, fields: Partial<MissionRun>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE mission_runs SET ${set} WHERE id = @id`).run({ ...fields, id });
}

export function listMissionRuns(db: Database.Database, missionId: string, limit = 100): MissionRun[] {
  return db.prepare('SELECT * FROM mission_runs WHERE mission_id = ? ORDER BY run_number DESC LIMIT ?')
    .all(missionId, limit) as MissionRun[];
}

/** Active missions whose next_run_at is due (<= now). Ordered oldest-due first. */
export function claimDueMissions(db: Database.Database, nowIso: string): Mission[] {
  return db.prepare(
    "SELECT * FROM missions WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC"
  ).all(nowIso) as Mission[];
}
