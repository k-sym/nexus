delete process.env.MONDAY_TOKEN;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import { buildMondayContext, buildMondayToolDeps, resolveThreadItem } from '../monday/session-deps';
import { upsertItems, linkTask } from '../monday/store';
import { loadConfig, saveConfig } from '../config';

/**
 * `clientOptions()` inside session-deps.ts reads `loadConfig().monday.enabled`
 * — the same global kill switch `routes/monday.ts` gates on, and the one the
 * shared `NexusConfig['monday']['enabled']` doc comment promises: "no tools
 * are registered" when it's false. It defaults to false (DEFAULT_CONFIG in
 * config.ts) on any machine that hasn't explicitly turned Monday on, so any
 * test that expects `buildMondayToolDeps` to hand back a non-null deps object
 * must flip it first — the same workaround test/monday-routes.test.ts already
 * uses for this exact gate. Always restored in `finally` so it can't leak
 * into later tests or this machine's real config.
 */
async function withMondayEnabled<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = loadConfig();
  saveConfig({ ...original, monday: { ...original.monday, enabled: true } });
  try {
    return await fn();
  } finally {
    saveConfig(original);
  }
}

function seed(db: ReturnType<typeof getDb>, updatesEnabled: boolean) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: updatesEnabled, min_interval_minutes: 30 },
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at, thread_id)
              VALUES ('t1','p1','Migrate DB','','review','medium','now','now','thread-1')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t2','p1','Sibling','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't2', item_id: '1', project_id: 'p1', created_at: 'now' });
}

test('resolveThreadItem finds the item via thread → task → link', () => {
  const db = getDb(':memory:');
  seed(db, false);
  const resolved = resolveThreadItem(db, 'thread-1')!;
  assert.equal(resolved.item.name, 'Ship the thing');
  assert.equal(resolved.taskId, 't1');
  assert.equal(resolved.projectId, 'p1');
  db.close();
});

test('resolveThreadItem returns null for a thread with no linked task', () => {
  const db = getDb(':memory:');
  seed(db, false);
  assert.equal(resolveThreadItem(db, 'thread-unknown'), null);
  db.close();
});

test('buildMondayContext counts siblings and formats the roll-up', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  await withMondayEnabled(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.equal(ctx.siblingCount, 2);
    assert.equal(ctx.rollupText, '1/2 done · 1 in review');
  });
  db.close();
});

test('buildMondayContext returns null when the thread has no link', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  await withMondayEnabled(() => {
    assert.equal(buildMondayContext(db, 'thread-unknown'), null);
  });
  db.close();
});

test('buildMondayContext returns null when Monday is globally disabled', () => {
  // IMPORTANT 2 regression: buildMondayToolDeps gates on monday.enabled (via
  // clientOptions()) but buildMondayContext did not, so a globally-disabled
  // Monday integration still injected a context block instructing the model
  // to "Call monday_get_item" — a tool that was never registered. Deliberately
  // NOT wrapped in withMondayEnabled: this exercises the default-disabled
  // state (DEFAULT_CONFIG.monday.enabled === false), which is what any
  // machine that hasn't explicitly opted in has. Before the fix this
  // returned a real context object, not null.
  const db = getDb(':memory:');
  seed(db, false);
  assert.equal(buildMondayContext(db, 'thread-1'), null);
  db.close();
});

test('tool deps omit postUpdate when the project has updates disabled', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  process.env.MONDAY_TOKEN = 'tok';
  await withMondayEnabled(() => {
    const deps = buildMondayToolDeps(db, 'thread-1')!;
    assert.equal(deps.postUpdate, undefined);
  });
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('tool deps include postUpdate when the project opts in', async () => {
  const db = getDb(':memory:');
  seed(db, true);
  process.env.MONDAY_TOKEN = 'tok';
  await withMondayEnabled(() => {
    const deps = buildMondayToolDeps(db, 'thread-1')!;
    assert.equal(typeof deps.postUpdate, 'function');
  });
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('tool deps are null without a token, so no tool is advertised', async () => {
  // IMPORTANT 3: this must genuinely exercise the token check. Without
  // withMondayEnabled, clientOptions() returns null at the `enabled` check
  // (default config has monday.enabled === false) before the token is ever
  // consulted — the test would still pass even if the token check were
  // deleted outright. Wrapping it, like its siblings above, forces enabled
  // to be true so the only remaining reason to return null is the token.
  const db = getDb(':memory:');
  seed(db, true);
  delete process.env.MONDAY_TOKEN;
  await withMondayEnabled(() => {
    assert.equal(buildMondayToolDeps(db, 'thread-1'), null);
  });
  db.close();
});

test('getItem dep reports the linked Nexus tasks', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  process.env.MONDAY_TOKEN = 'tok';
  await withMondayEnabled(async () => {
    const deps = buildMondayToolDeps(db, 'thread-1')!;
    const detail = await deps.getItem('1');
    assert.equal(detail!.linked_tasks.length, 2);
    assert.ok(detail!.linked_tasks.some((t) => t.title === 'Migrate DB'));
  });
  delete process.env.MONDAY_TOKEN;
  db.close();
});

// --- IMPORTANT 1: recentUpdates() must never mistake a COLUMN VALUE for a
// real update. Monday's updates feed isn't mirrored at all yet (no client
// fetch, no schema field) — a column whose id happens to be literally
// "updates" must not leak its column value through as if it were one.

test('buildMondayContext never surfaces a column literally named "updates" as an update', async () => {
  // The exact bug described in IMPORTANT 1: recentUpdates() used to read
  // cols.updates?.text out of column_values_json — the blob that holds
  // COLUMN VALUES keyed by column id, not the updates feed. A board with a
  // column whose id happens to be "updates" would render that COLUMN VALUE
  // to the model, mislabelled as an update. Monday's real updates feed is
  // not mirrored at all yet, so this must always come back empty — even
  // though column_values_json here has an "updates"-keyed entry with text.
  const db = getDb(':memory:');
  seed(db, false);
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null,
    column_values_json: JSON.stringify({ updates: { id: 'updates', type: 'text', text: 'Not a real update — a column value' } }),
    monday_updated_at: null, synced_at: 'later',
  }]);
  await withMondayEnabled(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.deepEqual(ctx.updates, []);
  });
  db.close();
});

test('getItem dep never surfaces a column literally named "updates" as an update', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null,
    column_values_json: JSON.stringify({ updates: { id: 'updates', type: 'text', text: 'Not a real update — a column value' } }),
    monday_updated_at: null, synced_at: 'later',
  }]);
  process.env.MONDAY_TOKEN = 'tok';
  await withMondayEnabled(async () => {
    const deps = buildMondayToolDeps(db, 'thread-1')!;
    const detail = await deps.getItem('1');
    assert.deepEqual(detail!.updates, []);
  });
  delete process.env.MONDAY_TOKEN;
  db.close();
});

// --- MINOR 4: an unvalidated `cfg.updates.enabled` access throws on a
// partial/legacy monday config with no `updates` key, and the outer catch
// then loses the READ tools too — not just the opt-in gate it should affect.

function seedMissingUpdatesBlock(db: ReturnType<typeof getDb>) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        // `updates` deliberately omitted — a partial/legacy config.
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at, thread_id)
              VALUES ('t1','p1','Migrate DB','','review','medium','now','now','thread-1')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
}

test('tool deps still include search/getItem when cfg.updates is missing entirely, only postUpdate is affected', async () => {
  const db = getDb(':memory:');
  seedMissingUpdatesBlock(db);
  process.env.MONDAY_TOKEN = 'tok';
  await withMondayEnabled(() => {
    const deps = buildMondayToolDeps(db, 'thread-1');
    assert.ok(deps, 'a missing updates block must not disable the whole deps object');
    assert.equal(typeof deps!.search, 'function');
    assert.equal(typeof deps!.getItem, 'function');
    assert.equal(deps!.postUpdate, undefined, 'no updates block means not opted in, not a crash');
  });
  delete process.env.MONDAY_TOKEN;
  db.close();
});
