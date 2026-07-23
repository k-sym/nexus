delete process.env.MONDAY_TOKEN;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { buildMondayContext, buildMondayToolDeps, resolveThreadItem } from '../monday/session-deps';
import { buildMondayContextBlock } from '../pi/monday-context';
import { upsertItems, linkTask } from '../monday/store';
import { loadConfig, saveConfig } from '../config';

// withMondayEnabled below calls saveConfig(), which writes config.yaml for
// real. Relocate the whole ~/.nexus tree to a scratch dir first: config.ts
// reads NEXUS_HOME on each call, so setting it here (after imports) still
// takes effect before any loadConfig/saveConfig call in this file.
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-monday-session-deps-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

/**
 * `clientOptions()` inside session-deps.ts reads `loadConfig().monday.enabled`
 * — the same global kill switch `routes/monday.ts` gates on, and the one the
 * shared `NexusConfig['monday']['enabled']` doc comment promises: "no tools
 * are registered" when it's false. It defaults to false (DEFAULT_CONFIG in
 * config.ts) on any machine that hasn't explicitly turned Monday on, so any
 * test that expects `buildMondayToolDeps` to hand back a non-null deps object
 * must flip it first — the same workaround test/monday-routes.test.ts already
 * uses for this exact gate. Always restored in `finally` so it can't leak
 * into later tests in this file (loadConfig/saveConfig here target the
 * private per-file scratch directory set up above, never the developer's
 * real ~/.nexus/config.yaml).
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
  process.env.MONDAY_TOKEN = 'tok';
  await withMondayEnabled(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.equal(ctx.siblingCount, 2);
    assert.equal(ctx.rollupText, '1/2 done · 1 in review');
  });
  delete process.env.MONDAY_TOKEN;
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

test('buildMondayContext returns null when Monday is enabled but MONDAY_TOKEN is unset', async () => {
  // The same class of defect already fixed for the `enabled` flag (the test
  // above): buildMondayContext gated only on monday.enabled, while
  // buildMondayToolDeps (via clientOptions()) also gated on
  // resolveMondayToken(). With enabled:true and no token — e.g. the app
  // relaunched outside the shell that exported MONDAY_TOKEN — a linked
  // thread got a context block ending "Call monday_get_item for current
  // state" while that tool was never registered. Both halves must now agree.
  const db = getDb(':memory:');
  seed(db, false);
  delete process.env.MONDAY_TOKEN;
  await withMondayEnabled(() => {
    assert.equal(buildMondayContext(db, 'thread-1'), null);
    // Prove this is genuinely the token gate, not the enabled gate: tool
    // deps are ALSO null under the identical conditions (the gate this test
    // exists to keep in parity with), and the config itself is otherwise
    // enough to resolve a thread (resolveThreadItem alone succeeds).
    assert.equal(buildMondayToolDeps(db, 'thread-1'), null);
    assert.ok(resolveThreadItem(db, 'thread-1'), 'the thread itself resolves fine — only the token gate should block context/tools');
  });
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
// real update. The two blobs sit next to each other on the same row and are
// one keystroke apart, so now that updates ARE mirrored — in updates_json —
// these guard the other blob: a column whose id happens to be literally
// "updates" must not leak its column value through as if it were one.

test('buildMondayContext never surfaces a column literally named "updates" as an update', async () => {
  // The exact bug described in IMPORTANT 1: recentUpdates() used to read
  // cols.updates?.text out of column_values_json — the blob that holds
  // COLUMN VALUES keyed by column id, not the updates feed. A board with a
  // column whose id happens to be "updates" would render that COLUMN VALUE
  // to the model, mislabelled as an update. This row has such a column and
  // an empty updates thread, so the result must be empty.
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
  await withMondayEnabled(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.deepEqual(ctx.updates, []);
  });
  delete process.env.MONDAY_TOKEN;
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

// --- The real updates thread, mirrored into monday_items.updates_json by
// mapItem from the `updates` connection client.ts now fetches.

/**
 * Enabled AND holding a token — the two halves of `mondayReady()`. These
 * tests are about what recentUpdates() returns, so both gates have to be open
 * or buildMondayContext short-circuits to null before it ever reads a row;
 * the gates themselves have their own dedicated tests above.
 */
async function withMondayLive<T>(fn: () => T | Promise<T>): Promise<T> {
  process.env.MONDAY_TOKEN = 'tok';
  try {
    return await withMondayEnabled(fn);
  } finally {
    delete process.env.MONDAY_TOKEN;
  }
}

/** Re-mirror the seeded item with a given updates blob. Deliberately writes
 *  the raw string, so malformed data — the case that decides whether a linked
 *  thread opens at all — can be exercised exactly as a bad row would hold it. */
function withUpdatesJson(db: ReturnType<typeof getDb>, updatesJson: string) {
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', updates_json: updatesJson,
    monday_updated_at: null, synced_at: 'later',
  }]);
}

test('buildMondayContext surfaces the item mirrored updates, newest first', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  // Stored in the order Monday sent (mapItem does not sort); ordering is this
  // function's job.
  withUpdatesJson(db, JSON.stringify([
    { text: 'Kicked off', created_at: '2026-07-19T09:00:00Z' },
    { text: 'Blocked on infra', created_at: '2026-07-21T09:00:00Z' },
    { text: 'Unblocked', created_at: '2026-07-20T09:00:00Z' },
  ]));
  await withMondayLive(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.deepEqual(ctx.updates, ['Blocked on infra', 'Unblocked', 'Kicked off']);
  });
  db.close();
});

test('the getItem dep surfaces the same updates as the context block', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  withUpdatesJson(db, JSON.stringify([{ text: 'Kicked off', created_at: '2026-07-19T09:00:00Z' }]));
  await withMondayLive(async () => {
    const detail = await buildMondayToolDeps(db, 'thread-1')!.getItem('1');
    assert.deepEqual(detail!.updates, ['Kicked off']);
  });
  db.close();
});

test('empty updates are dropped and undated ones sort last, without reordering the dated ones', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  withUpdatesJson(db, JSON.stringify([
    { text: '   ', created_at: '2026-07-22T09:00:00Z' },
    { text: 'No timestamp', created_at: null },
    { text: 'Older', created_at: '2026-07-19T09:00:00Z' },
    { text: 'Newer', created_at: '2026-07-21T09:00:00Z' },
  ]));
  await withMondayLive(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.deepEqual(ctx.updates, ['Newer', 'Older', 'No timestamp']);
  });
  db.close();
});

// A throw here happens during agent session creation, which would leave the
// chat thread permanently unopenable — so every malformed shape must degrade
// to an empty list instead. Each case is a row a past mapItem, a partial
// write, or a hand-edited database could genuinely leave behind.
for (const [label, blob] of [
  ['not JSON at all', 'not json'],
  ['a JSON scalar', '"just a string"'],
  ['a JSON object rather than an array', '{"text":"nope"}'],
  ['an empty string', ''],
  ['an array of nulls and scalars', '[null, 42, "loose text"]'],
  ['entries missing every expected key', '[{"body":"wrong key"},{}]'],
  ['entries whose text is not a string', '[{"text":{"nested":true},"created_at":"2026-07-21T09:00:00Z"}]'],
] as const) {
  test(`updates_json holding ${label} degrades to no updates instead of throwing`, async () => {
    const db = getDb(':memory:');
    seed(db, false);
    withUpdatesJson(db, blob);
    await withMondayLive(async () => {
      const ctx = buildMondayContext(db, 'thread-1');
      assert.ok(ctx, 'the context block must still be built — a null here is a broken thread');
      assert.deepEqual(ctx.updates, []);
      const detail = await buildMondayToolDeps(db, 'thread-1')!.getItem('1');
      assert.deepEqual(detail!.updates, []);
    });
    db.close();
  });
}

// --- The injected block's cap, fed real mirrored updates.
//
// pi/monday-context.ts drops updates FIRST when the block is over budget.
// Its own unit tests hand it an updates array directly, so that path was
// already covered in isolation — but until updates were actually mirrored,
// nothing exercised it end to end, and every real block had an empty list to
// "drop". These run the whole path: mirror row → buildMondayContext →
// buildMondayContextBlock.

test('a long real update thread is dropped down to fit, keeping the head and the refresh hint', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  withUpdatesJson(db, JSON.stringify(
    Array.from({ length: 40 }, (_, i) => ({
      text: `Update number ${i} with a good deal of text in it`,
      // i=39 is the newest.
      created_at: `2026-07-${String(i + 1).padStart(2, '0')}T09:00:00Z`,
    })),
  ));
  await withMondayLive(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    assert.equal(ctx.updates.length, 40, 'all mirrored updates reach the block builder');

    const block = buildMondayContextBlock(ctx, 600);
    assert.ok(block.length <= 600, `block must respect the cap, got ${block.length}`);
    // The head and the tail are what must survive the squeeze.
    assert.match(block, /Initiative: Ship the thing/);
    assert.match(block, /Nexus tasks under this initiative/);
    assert.match(block, /Call monday_get_item for current state/);
    // Something had to go: not every update can fit in 600 chars.
    const kept = block.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(kept.length < 40, 'updates must be the thing that gets dropped');
  });
  db.close();
});

test('when updates are trimmed to fit, the ones kept are the newest', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  withUpdatesJson(db, JSON.stringify([
    { text: 'Oldest of the three', created_at: '2026-07-01T09:00:00Z' },
    { text: 'Newest of the three', created_at: '2026-07-03T09:00:00Z' },
    { text: 'Middle of the three', created_at: '2026-07-02T09:00:00Z' },
  ]));
  await withMondayLive(() => {
    const ctx = buildMondayContext(db, 'thread-1')!;
    // A cap with room for exactly one update, derived rather than hardcoded
    // so it cannot drift as the head lines change. Which update survives is
    // the point: recentUpdates orders newest-first and the block fills from
    // the front, so the one that fits is the most recent, not an arbitrary one.
    const oneUpdate = buildMondayContextBlock({ ...ctx, updates: ctx.updates.slice(0, 1) }, Infinity);
    const block = buildMondayContextBlock(ctx, oneUpdate.length);
    const kept = block.split('\n').filter((l) => l.startsWith('- '));
    assert.deepEqual(kept, ['- Newest of the three']);
  });
  db.close();
});

test('an over-budget block with no room for any update still ends with the refresh hint', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  withUpdatesJson(db, JSON.stringify([{ text: 'A'.repeat(400), created_at: '2026-07-03T09:00:00Z' }]));
  await withMondayLive(() => {
    const block = buildMondayContextBlock(buildMondayContext(db, 'thread-1')!, 400);
    assert.doesNotMatch(block, /Recent updates:/, 'a header with no updates under it must not be emitted');
    assert.match(block, /Call monday_get_item for current state/);
  });
  db.close();
});

test('with both present, only the real updates thread is surfaced — never the "updates" column', async () => {
  // The sharpest form of IMPORTANT 1: the row carries a genuine update AND a
  // column whose id is literally "updates". Reading the wrong blob would show
  // the column value; reading both would show two. Exactly one is correct.
  const db = getDb(':memory:');
  seed(db, false);
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null,
    column_values_json: JSON.stringify({ updates: { id: 'updates', type: 'text', text: 'A column value, not an update' } }),
    updates_json: JSON.stringify([{ text: 'A genuine update', created_at: '2026-07-21T09:00:00Z' }]),
    monday_updated_at: null, synced_at: 'later',
  }]);
  await withMondayLive(() => {
    assert.deepEqual(buildMondayContext(db, 'thread-1')!.updates, ['A genuine update']);
  });
  db.close();
});
