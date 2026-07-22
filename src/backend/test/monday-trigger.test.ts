delete process.env.MONDAY_TOKEN;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayProjectConfig, Project } from '@nexus/shared';
import { getDb } from '../db';
import { scheduleRollup, disableRollupForProject } from '../monday/trigger';
import { __resetWriteState } from '../monday/writes';
import { upsertItems, linkTask } from '../monday/store';
import { MondayError } from '../monday/client';
import { loadConfig, saveConfig } from '../config';
import type { ActivityEvent } from '../activity/events';

beforeEach(() => __resetWriteState());

/**
 * scheduleRollup reads `loadConfig().monday.enabled` as its global kill
 * switch — the same gate `routes/monday.ts` and `monday/session-deps.ts`
 * already need this exact workaround for (see monday-routes.test.ts and
 * monday-session-deps.test.ts). It defaults to false on any machine that
 * hasn't explicitly turned Monday on, so any test that expects a write to
 * actually go through must flip it first. Always restored in `finally` so
 * it can't leak into later tests or this machine's real config.
 */
async function withMondayEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const original = loadConfig();
  saveConfig({ ...original, monday: { ...original.monday, enabled: true } });
  try {
    return await fn();
  } finally {
    saveConfig(original);
  }
}

function seed(db: ReturnType<typeof getDb>) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: false, min_interval_minutes: 30 },
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','A','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  process.env.MONDAY_TOKEN = 'tok';
}

function readConfig(db: ReturnType<typeof getDb>): MondayProjectConfig {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Project;
  return (JSON.parse(project.config_json) as { monday: MondayProjectConfig }).monday;
}

test('a rollup write emits a monday_write operation', async () => {
  const db = getDb(':memory:');
  seed(db);
  const events: ActivityEvent[] = [];
  await withMondayEnabled(() =>
    scheduleRollup(db, 't1', null, (e) => events.push(e), { setColumn: async () => {}, postUpdate: async () => {} } as never),
  );
  assert.equal(events[0].kind, 'monday_write');
  assert.equal(events.at(-1)!.status, 'succeeded');
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('scheduleRollup is a no-op for an unlinked task and never throws', async () => {
  const db = getDb(':memory:');
  seed(db);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t9','p1','B','','todo','medium','now','now')`).run();
  const events: ActivityEvent[] = [];
  await scheduleRollup(db, 't9', null, (e) => events.push(e));
  assert.equal(events.length, 0);
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('a failed write does not throw — the caller must not be blocked', async () => {
  const db = getDb(':memory:');
  seed(db);
  const events: ActivityEvent[] = [];
  await withMondayEnabled(() =>
    scheduleRollup(db, 't1', null, (e) => events.push(e), {
      setColumn: async () => { throw new MondayError('rate limited', 'RateLimit', 429, 10); },
      postUpdate: async () => {},
    } as never),
  );
  assert.equal(events.at(-1)!.status, 'failed');
  assert.equal(readConfig(db).rollup.enabled, true, 'a retryable failure must not disable roll-up');
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('a deleted roll-up column self-disables the project and notifies once', async () => {
  const db = getDb(':memory:');
  seed(db);
  const fail = { setColumn: async () => { throw new MondayError('Column not found', 'ColumnValueException', 200); }, postUpdate: async () => {} };
  await withMondayEnabled(async () => {
    await scheduleRollup(db, 't1', null, undefined, fail as never);
    assert.equal(readConfig(db).rollup.enabled, false);
    const notes = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
    assert.equal(notes.c, 1);

    // Now disabled, a second call must not write or notify again.
    await scheduleRollup(db, 't1', null, undefined, fail as never);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c, 1);
  });
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('disableRollupForProject preserves the rest of the project config', () => {
  const db = getDb(':memory:');
  seed(db);
  disableRollupForProject(db, 'p1', 'column deleted');
  const cfg = readConfig(db);
  assert.equal(cfg.rollup.enabled, false);
  assert.equal(cfg.board_id, 'b1', 'scope must survive');
  assert.equal(cfg.updates.min_interval_minutes, 30);
  delete process.env.MONDAY_TOKEN;
  db.close();
});
