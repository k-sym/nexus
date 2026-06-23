import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { triageTicketsHandler } from '../missions/handlers/triage-tickets';
import type { Mission } from '@nexus/shared';

function freshDb() {
  const base = join(tmpdir(), `nexus-mhand-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES ('p1','p1','P','','/tmp/p1','{}',0,'', ?, ?)").run(now, now);
  // tickets table: key, summary, status, priority, assignee, source, synced_at (no project_id — global)
  db.prepare("INSERT INTO tickets (key, summary, status, priority, assignee, source, synced_at) VALUES ('T-1','Fix bug','Open','High','me','jira', ?)").run(now);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

function mission(db: any): Mission {
  return {
    id: 'm1', project_id: 'p1', title: 'triage', description: '', kind: 'triage_tickets',
    config_json: JSON.stringify({ max_per_run: 10 }), pacing: 'backlog_drain', interval_seconds: 60,
    max_iterations: null, max_wall_clock_seconds: null, max_tokens: null,
    run_window_start: null, run_window_end: null, status: 'active', iteration_count: 0,
    tokens_used: 0, next_run_at: null, started_at: new Date().toISOString(), last_run_at: null,
    stopped_at: null, stop_reason: null, created_at: '', updated_at: '',
  };
}

test('triage_tickets creates a task for an un-triaged ticket then drains', async () => {
  const { db, cleanup } = freshDb();
  const ctx = { db, mission: mission(db), runNumber: 1, signal: new AbortController().signal, deps: {} };

  const first = await triageTicketsHandler(ctx as never);
  const taskCount = (db.prepare("SELECT COUNT(*) c FROM tasks WHERE project_id='p1'").get() as { c: number }).c;
  assert.equal(first.status, 'succeeded');
  assert.equal(taskCount, 1);
  assert.equal(first.drained, false);

  const second = await triageTicketsHandler({ ...ctx, runNumber: 2 } as never);
  cleanup();
  assert.equal(second.drained, true, 'no tickets left to triage');
});
