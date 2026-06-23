import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { insertMission, getMission, listMissionRuns } from '../missions/store';
import { runMissionOnce } from '../missions/runner';

function freshDb() {
  const base = join(tmpdir(), `nexus-mrun-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  db.prepare(
    "INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES ('p1','p1','P','', '/tmp/p1','{}',0,'', ?, ?)"
  ).run(new Date().toISOString(), new Date().toISOString());
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('runMissionOnce executes the handler, writes a ledger row, and schedules the next run', async () => {
  const { db, cleanup } = freshDb();
  const m = insertMission(db, {
    project_id: 'p1', title: 'echo mission', description: '', kind: 'echo',
    config_json: JSON.stringify({ message: 'hi' }), pacing: 'fixed', interval_seconds: 600,
    max_iterations: 5, max_wall_clock_seconds: null, max_tokens: null,
    run_window_start: null, run_window_end: null, status: 'active',
    next_run_at: new Date().toISOString(), started_at: new Date().toISOString(),
  });

  const { mission, run } = await runMissionOnce(db, m, {});
  cleanup();

  assert.equal(run.status, 'succeeded');
  assert.equal(run.run_number, 1);
  assert.match(run.result_summary, /echoed: hi/);
  assert.equal(mission.iteration_count, 1);
  assert.equal(mission.status, 'active');
  assert.ok(mission.next_run_at, 'next_run_at scheduled');
});

test('runMissionOnce stops the mission when max_iterations is already reached', async () => {
  const { db, cleanup } = freshDb();
  const m = insertMission(db, {
    project_id: 'p1', title: 'capped', description: '', kind: 'echo',
    config_json: '{}', pacing: 'fixed', interval_seconds: 600,
    max_iterations: 1, max_wall_clock_seconds: null, max_tokens: null,
    run_window_start: null, run_window_end: null, status: 'active',
    next_run_at: new Date().toISOString(), started_at: new Date().toISOString(),
  });

  const first = await runMissionOnce(db, m, {});
  assert.equal(first.mission.iteration_count, 1);
  // mission already at the cap after the first run -> a second attempt stops it
  const reloaded = getMission(db, m.id)!;
  const second = await runMissionOnce(db, reloaded, {});
  const runs = listMissionRuns(db, m.id);
  cleanup();

  assert.equal(second.mission.status, 'stopped');
  assert.equal(second.mission.stop_reason, 'max_iterations');
  assert.equal(runs.length, 1, 'no ledger row added for the blocked run');
});

test('runMissionOnce stops with reason drained for backlog_drain when handler reports drained', async () => {
  const { db, cleanup } = freshDb();
  const m = insertMission(db, {
    project_id: 'p1', title: 'drain', description: '', kind: 'echo',
    config_json: JSON.stringify({ drainAfter: 0 }), pacing: 'backlog_drain', interval_seconds: 1,
    max_iterations: null, max_wall_clock_seconds: null, max_tokens: null,
    run_window_start: null, run_window_end: null, status: 'active',
    next_run_at: new Date().toISOString(), started_at: new Date().toISOString(),
  });

  const { mission, run } = await runMissionOnce(db, m, {});
  cleanup();

  assert.equal(mission.status, 'stopped');
  assert.equal(mission.stop_reason, 'drained');
  assert.equal(run.stop_reason, 'drained');
  assert.equal(run.next_run_at, null);
});
