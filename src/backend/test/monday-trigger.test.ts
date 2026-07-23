import './support/nexus-test-dir';

delete process.env.MONDAY_TOKEN;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
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
 * it can't leak into later tests in this file (loadConfig/saveConfig here
 * target the private per-file directory set up by support/nexus-test-dir,
 * never the developer's real ~/.nexus/config.yaml).
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
  // Wrapped like its siblings: with Monday genuinely enabled and tokened, the
  // ONLY thing that can explain zero events is the unlinked-task check itself
  // — not the disabled-by-default kill switch, which would produce the same
  // "zero events" outcome for an unrelated reason and mask a broken guard.
  await withMondayEnabled(() => scheduleRollup(db, 't9', null, (e) => events.push(e)));
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

test('scheduleRollup resolves rather than rejects when the DB predates the Monday tables', async () => {
  // A schema with no task_monday_links table at all — the exact case the
  // docblock's outer try/catch calls out: "a caller whose schema predates the
  // Monday tables". getLinkForTask's very first query throws before any
  // Monday-specific guard (enabled, token, project config) ever runs.
  //
  // scheduleRollup is declared `async`, so even with the try/catch DELETED
  // this throw would still be delivered as a promise rejection rather than a
  // synchronous exception at the call site — but a `void`-ed fire-and-forget
  // call site (every real call site in routes/) does nothing to handle a
  // REJECTED promise. Left unhandled, Node treats that as a crash. The outer
  // try/catch is what turns this into a resolved promise instead, and that is
  // exactly what this test would catch if it were removed.
  const bareDb = new Database(':memory:');
  await assert.doesNotReject(() => scheduleRollup(bareDb, 't1', null));
  bareDb.close();
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

test('disableRollupForProject is idempotent — calling it twice notifies exactly once', () => {
  // Exercises disableRollupForProject directly, not through scheduleRollup:
  // the sequential double-call test above passes because scheduleRollupForItem
  // gates on `projectCfg.rollup.enabled` before ever reaching this function
  // again — it never proves disableRollupForProject itself is idempotent.
  // Two task moves racing against the same project's configuration error
  // could both reach this function before either write has landed, which is
  // exactly what a direct double-call simulates.
  const db = getDb(':memory:');
  seed(db);
  disableRollupForProject(db, 'p1', 'column deleted');
  assert.equal(readConfig(db).rollup.enabled, false);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c, 1);

  disableRollupForProject(db, 'p1', 'column deleted');
  assert.equal(readConfig(db).rollup.enabled, false);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c,
    1,
    'a second call against an already-disabled project must not notify again',
  );
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('scheduleRollup degrades to a no-op, not a throw, on a project config with no rollup sub-key at all', async () => {
  // There is currently no UI that writes projects.config_json — a
  // hand-written partial `monday` block (board_id present, `rollup` entirely
  // absent) is real, reachable input. Before the optional-chain fix,
  // `!projectCfg.rollup.enabled` threw a TypeError here, swallowed by the
  // outer catch and mislogged as "failed unexpectedly" instead of degrading
  // to "roll-up not enabled".
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({ monday: { board_id: 'b1', group_id: null } }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','A','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  process.env.MONDAY_TOKEN = 'tok';

  // A bare `!projectCfg.rollup.enabled` throw and a guarded early `return`
  // are otherwise indistinguishable from the events array alone: the throw
  // happens before the `start` event is ever emitted, so both paths leave
  // `events` empty. The one place they differ is the outer catch's
  // console.error — only the throw-then-catch path logs "failed
  // unexpectedly". Capture it to actually discriminate the two.
  const loggedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { loggedErrors.push(args); };

  const events: ActivityEvent[] = [];
  try {
    await withMondayEnabled(() =>
      scheduleRollup(db, 't1', null, (e) => events.push(e), { setColumn: async () => { throw new Error('must not be called'); }, postUpdate: async () => {} } as never),
    );
  } finally {
    console.error = originalConsoleError;
  }
  // Degrades quietly: no monday_write operation is emitted (matches the
  // existing "roll-up disabled" no-op shape), AND — the real proof this
  // isn't the outer catch's error path — nothing was logged as an
  // unexpected failure.
  assert.equal(events.length, 0);
  assert.equal(loggedErrors.length, 0, 'a guarded no-op must not be logged as "failed unexpectedly"');
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('disableRollupForProject preserves the rest of the project config', () => {
  const db = getDb(':memory:');
  seed(db);
  // seed()'s config_json carries ONLY a `monday` key, which would let this
  // test pass even if disableRollupForProject clobbered every non-Monday key
  // in the blob — it would just never be caught. Inject an unrelated
  // top-level key (the shape a real project config carries alongside
  // `monday`; see ProjectConfig in shared) so "preserves the rest" actually
  // exercises a non-Monday key surviving untouched.
  const before = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Project;
  const seededCfg = JSON.parse(before.config_json) as Record<string, unknown>;
  seededCfg.column_defaults = { triage: 'todo' };
  db.prepare('UPDATE projects SET config_json = ? WHERE id = ?').run(JSON.stringify(seededCfg), 'p1');

  disableRollupForProject(db, 'p1', 'column deleted');

  const after = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Project;
  const cfg = JSON.parse(after.config_json) as { monday: MondayProjectConfig; column_defaults?: unknown };
  assert.equal(cfg.monday.rollup.enabled, false);
  assert.equal(cfg.monday.board_id, 'b1', 'scope must survive');
  assert.equal(cfg.monday.updates.min_interval_minutes, 30);
  assert.deepEqual(cfg.column_defaults, { triage: 'todo' }, 'a non-Monday config key must survive untouched');
  delete process.env.MONDAY_TOKEN;
  db.close();
});
