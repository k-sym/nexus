import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';

function freshDb() {
  const base = join(tmpdir(), `nexus-missions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('missions table has the expected columns', () => {
  const { db, cleanup } = freshDb();
  const cols = (db.pragma('table_info(missions)') as { name: string }[]).map((c) => c.name);
  cleanup();
  for (const c of [
    'id', 'project_id', 'title', 'description', 'kind', 'config_json', 'pacing',
    'interval_seconds', 'max_iterations', 'max_wall_clock_seconds', 'max_tokens',
    'run_window_start', 'run_window_end', 'status', 'iteration_count', 'tokens_used',
    'next_run_at', 'started_at', 'last_run_at', 'stopped_at', 'stop_reason',
    'created_at', 'updated_at',
  ]) {
    assert.ok(cols.includes(c), `missions.${c} column present`);
  }
});

test('mission_runs table has the expected columns', () => {
  const { db, cleanup } = freshDb();
  const cols = (db.pragma('table_info(mission_runs)') as { name: string }[]).map((c) => c.name);
  cleanup();
  for (const c of [
    'id', 'mission_id', 'run_number', 'started_at', 'completed_at', 'status',
    'intent', 'selected_work_json', 'result_summary', 'tokens_used', 'error',
    'next_run_at', 'stop_reason', 'created_at',
  ]) {
    assert.ok(cols.includes(c), `mission_runs.${c} column present`);
  }
});
