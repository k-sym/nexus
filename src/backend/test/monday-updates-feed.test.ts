// A live MONDAY_TOKEN in the dev shell would make the "dormant" cases pass
// for the wrong reason — the same trap JIRA_TOKEN set once.
delete process.env.MONDAY_TOKEN;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MondayProjectConfig, Task } from '@nexus/shared';
import { getDb } from '../db';
import { loadConfig, saveConfig } from '../config';
import { upsertItems, linkTask } from '../monday/store';
import {
  formatFeedUpdate, feedWindowMs, taskIssueUrl, recordFeedEvent, flushDueFeedUpdates,
  scheduleFeedMove, scheduleFeedNote, type FeedEvent, type FeedDeps,
} from '../monday/updates-feed';
import type { ActivityEvent } from '../activity/events';

// saveConfig writes config.yaml for real; point the whole ~/.nexus tree at a
// scratch dir first (config.ts reads NEXUS_HOME on every call).
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-monday-feed-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

const OPTS = { token: 'tok', apiVersion: '2026-07' };
const MINUTE = 60_000;
const T0 = Date.parse('2026-09-08T10:00:00.000Z');

function cfg(over: Partial<MondayProjectConfig> = {}): MondayProjectConfig {
  return {
    board_id: 'b1', group_id: null,
    rollup: { enabled: false, column_id: null, column_type: 'text' },
    updates: { enabled: true, min_interval_minutes: 30 },
    ...over,
  };
}

function moved(taskId: string, title: string, status: 'review' | 'deploy', url: string | null = null): FeedEvent {
  return { kind: 'moved', task_id: taskId, title, status, url, at: new Date(T0).toISOString() };
}

function seed(db: ReturnType<typeof getDb>, config: MondayProjectConfig | null = cfg(), gitRemote = 'git@github.com:k-sym/nexus.git') {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, ?, 'now','now')`)
    .run(JSON.stringify(config ? { monday: config } : {}), gitRemote);
  upsertItems(db, [{
    item_id: 'i1', board_id: 'b1', board_name: 'Board', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
}

function seedTask(db: ReturnType<typeof getDb>, id: string, title: string, status: string, external?: { source: string; id: string }): Task {
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, external_source, external_id, created_at, updated_at)
              VALUES (?, 'p1', ?, '', ?, 'medium', ?, ?, 'now', 'now')`)
    .run(id, title, status, external?.source ?? null, external?.id ?? null);
  linkTask(db, { task_id: id, item_id: 'i1', project_id: 'p1', created_at: 'now' });
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
}

function fakePoster(fail = false): { deps: FeedDeps; posts: { itemId: string; body: string }[] } {
  const posts: { itemId: string; body: string }[] = [];
  return {
    posts,
    deps: {
      postUpdate: async (_opts, itemId, body) => {
        if (fail) throw Object.assign(new Error('boom'), { code: 'InternalServerError' });
        posts.push({ itemId, body });
      },
    },
  };
}

async function withMondayEnabled<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = loadConfig();
  saveConfig({ ...original, monday: { ...original.monday, enabled: true } });
  process.env.MONDAY_TOKEN = 'tok';
  try {
    return await fn();
  } finally {
    delete process.env.MONDAY_TOKEN;
    saveConfig(original);
  }
}

// --- pure ---------------------------------------------------------------

test('feedWindowMs reads min_interval_minutes, floors it to 5, defaults to 30', () => {
  assert.equal(feedWindowMs(cfg()), 30 * MINUTE);
  assert.equal(feedWindowMs(cfg({ updates: { enabled: true, min_interval_minutes: 45 } })), 45 * MINUTE);
  assert.equal(feedWindowMs(cfg({ updates: { enabled: true, min_interval_minutes: 1 } })), 5 * MINUTE);
  assert.equal(feedWindowMs({ board_id: 'b1' } as MondayProjectConfig), 30 * MINUTE);
  assert.equal(feedWindowMs(null), 30 * MINUTE);
});

test('formatFeedUpdate lists moves one per task with the GitHub link and the latest state per task', () => {
  const body = formatFeedUpdate([
    moved('t1', 'Fix login <redirect>', 'review', 'https://github.com/k-sym/nexus/issues/12'),
    moved('t2', 'Add stale endpoint', 'review'),
    moved('t1', 'Fix login <redirect>', 'deploy', 'https://github.com/k-sym/nexus/issues/12'),
  ]);
  assert.equal(body, [
    '<b>Nexus</b> · 2 tasks moved',
    '• <a href="https://github.com/k-sym/nexus/issues/12">Fix login &lt;redirect&gt;</a> → Done',
    '• Add stale endpoint → Review',
  ].join('<br>'));
});

test('formatFeedUpdate escapes agent notes and appends the provenance line', () => {
  const body = formatFeedUpdate([
    moved('t1', 'A', 'review'),
    { kind: 'note', body: 'Shipped <b>v2</b>\nsee PR', provenance: 'Nexus task "A" (thread th1)', at: 'now' },
  ]);
  assert.equal(body, [
    '<b>Nexus</b> · 1 task moved',
    '• A → Review',
    '',
    'Shipped &lt;b&gt;v2&lt;/b&gt;<br>see PR',
    '— posted by Nexus on behalf of Nexus task &quot;A&quot; (thread th1)',
  ].join('<br>'));
});

test('taskIssueUrl links a GitHub-sourced task to its issue and nothing else', () => {
  const db = getDb(':memory:');
  seed(db);
  assert.equal(taskIssueUrl(db, { project_id: 'p1', external_source: 'github', external_id: '12' }), 'https://github.com/k-sym/nexus/issues/12');
  assert.equal(taskIssueUrl(db, { project_id: 'p1', external_source: null, external_id: null }), null);
  assert.equal(taskIssueUrl(db, { project_id: 'p1', external_source: 'jira', external_id: 'SUP-1' }), null);
  assert.equal(taskIssueUrl(db, { project_id: 'p1', external_source: 'github', external_id: 'abc' }), null);
  db.close();
});

test('taskIssueUrl returns null when the project has no parseable GitHub remote', () => {
  const db = getDb(':memory:');
  seed(db, cfg(), 'https://gitlab.com/x/y.git');
  assert.equal(taskIssueUrl(db, { project_id: 'p1', external_source: 'github', external_id: '12' }), null);
  db.close();
});

// --- throttle (DB-backed) ----------------------------------------------

test('an isolated event posts immediately, then events inside the window queue and coalesce into one post', async () => {
  const db = getDb(':memory:');
  seed(db);
  const { deps, posts } = fakePoster();
  assert.equal(await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, deps), 'posted');
  assert.equal(posts.length, 1);
  assert.equal(await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t2', 'B', 'review'), T0 + 5 * MINUTE, deps), 'queued');
  assert.equal(await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t3', 'C', 'deploy'), T0 + 10 * MINUTE, deps), 'queued');
  assert.equal(posts.length, 1, 'nothing posted inside the window');

  await withMondayEnabled(async () => {
    assert.equal(await flushDueFeedUpdates(db, T0 + 20 * MINUTE, deps), 0, 'not due yet');
    assert.equal(await flushDueFeedUpdates(db, T0 + 30 * MINUTE, deps), 1, 'due at window end');
  });
  assert.equal(posts.length, 2);
  assert.match(posts[1].body, /2 tasks moved/);
  assert.match(posts[1].body, /B → Review/);
  assert.match(posts[1].body, /C → Done/);
  db.close();
});

test('a leading-edge post takes anything already queued with it, in order', async () => {
  const db = getDb(':memory:');
  seed(db);
  const { deps, posts } = fakePoster();
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, deps);
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t2', 'B', 'review'), T0 + MINUTE, deps);
  assert.equal(await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t3', 'C', 'review'), T0 + 31 * MINUTE, deps), 'posted');
  assert.equal(posts.length, 2);
  assert.ok(posts[1].body.indexOf('B →') < posts[1].body.indexOf('C →'));
  db.close();
});

test('the throttle is per item', async () => {
  const db = getDb(':memory:');
  seed(db);
  upsertItems(db, [{
    item_id: 'i2', board_id: 'b1', board_name: 'Board', group_id: null, group_title: null,
    name: 'Other', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  const { deps, posts } = fakePoster();
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, deps);
  assert.equal(await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i2', moved('t2', 'B', 'review'), T0 + MINUTE, deps), 'posted');
  assert.equal(posts.length, 2);
  db.close();
});

test('the window survives a restart because it lives in the DB, not memory', async () => {
  const db = getDb(':memory:');
  seed(db);
  const { deps } = fakePoster();
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, deps);
  const row = db.prepare('SELECT * FROM monday_update_feed WHERE item_id = ?').get('i1') as { last_posted_at: string; pending_json: string };
  assert.equal(row.last_posted_at, new Date(T0).toISOString());
  assert.equal(row.pending_json, '[]');
  db.close();
});

test('a failed post keeps its events queued, restarts the window, and reports the failed operation', async () => {
  const db = getDb(':memory:');
  seed(db);
  const events: ActivityEvent[] = [];
  const failing = fakePoster(true);
  assert.equal(await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, failing.deps, (e) => events.push(e)), 'failed');
  assert.equal(events.at(-1)!.kind, 'monday_write');
  assert.equal(events.at(-1)!.status, 'failed');
  const row = db.prepare('SELECT pending_json FROM monday_update_feed WHERE item_id = ?').get('i1') as { pending_json: string };
  assert.equal((JSON.parse(row.pending_json) as unknown[]).length, 1, 'nothing dropped');

  // Retried one window later, not in a tight loop; succeeds when Monday does.
  const ok = fakePoster();
  await withMondayEnabled(async () => {
    assert.equal(await flushDueFeedUpdates(db, T0 + 10 * MINUTE, ok.deps), 0);
    assert.equal(await flushDueFeedUpdates(db, T0 + 30 * MINUTE, ok.deps), 1);
  });
  assert.equal(ok.posts.length, 1);
  db.close();
});

test('flush drops a queue whose project has since turned updates off', async () => {
  const db = getDb(':memory:');
  seed(db);
  const { deps, posts } = fakePoster();
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, deps);
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t2', 'B', 'review'), T0 + MINUTE, deps);
  db.prepare('UPDATE projects SET config_json = ? WHERE id = ?')
    .run(JSON.stringify({ monday: cfg({ updates: { enabled: false, min_interval_minutes: 30 } }) }), 'p1');
  await withMondayEnabled(async () => {
    assert.equal(await flushDueFeedUpdates(db, T0 + 60 * MINUTE, deps), 0);
  });
  assert.equal(posts.length, 1);
  const row = db.prepare('SELECT pending_json FROM monday_update_feed WHERE item_id = ?').get('i1') as { pending_json: string };
  assert.equal(row.pending_json, '[]');
  db.close();
});

test('flush is dormant when Monday is disabled or there is no token', async () => {
  const db = getDb(':memory:');
  seed(db);
  const { deps } = fakePoster();
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t1', 'A', 'review'), T0, deps);
  await recordFeedEvent(db, OPTS, 'p1', cfg(), 'i1', moved('t2', 'B', 'review'), T0 + MINUTE, deps);
  assert.equal(await flushDueFeedUpdates(db, T0 + 60 * MINUTE, deps), 0);
  db.close();
});

// --- triggers -------------------------------------------------------------

test('scheduleFeedMove posts a colleague-readable note with the GitHub link for a move into Review', async () => {
  const db = getDb(':memory:');
  seed(db);
  const task = seedTask(db, 't1', 'Fix login redirect', 'review', { source: 'github', id: '12' });
  const { deps, posts } = fakePoster();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    assert.equal(await scheduleFeedMove(db, task, (e) => events.push(e), deps, T0), 'posted');
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].itemId, 'i1');
  assert.equal(posts[0].body, '<b>Nexus</b> · 1 task moved<br>• <a href="https://github.com/k-sym/nexus/issues/12">Fix login redirect</a> → Review');
  assert.equal(events[0].kind, 'monday_write');
  assert.equal(events[0].taskId, 't1');
  db.close();
});

test('scheduleFeedMove is a silent no-op for other statuses, unlinked tasks, and projects that have not opted in', async () => {
  const db = getDb(':memory:');
  seed(db, cfg({ updates: { enabled: false, min_interval_minutes: 30 } }));
  const linked = seedTask(db, 't1', 'A', 'review');
  const { deps, posts } = fakePoster();
  await withMondayEnabled(async () => {
    assert.equal(await scheduleFeedMove(db, linked, undefined, deps, T0), 'skipped', 'not opted in');
    assert.equal(await scheduleFeedMove(db, { ...linked, status: 'in_progress' }, undefined, deps, T0), 'skipped', 'not a Review/Deploy move');
    db.prepare('UPDATE projects SET config_json = ? WHERE id = ?').run(JSON.stringify({ monday: cfg() }), 'p1');
    assert.equal(await scheduleFeedMove(db, { ...linked, id: 'nope' }, undefined, deps, T0), 'skipped', 'unlinked');
  });
  assert.equal(await scheduleFeedMove(db, linked, undefined, deps, T0), 'skipped', 'Monday off globally');
  assert.equal(posts.length, 0);
  db.close();
});

test('scheduleFeedNote (the agent path) shares the item window with automated moves and reports queued honestly', async () => {
  const db = getDb(':memory:');
  seed(db);
  const task = seedTask(db, 't1', 'A', 'review');
  const { deps, posts } = fakePoster();
  await withMondayEnabled(async () => {
    await scheduleFeedMove(db, task, undefined, deps, T0);
  });
  const outcome = await scheduleFeedNote(db, OPTS, 'p1', cfg(), 'i1', 'Halfway there', 'Nexus task "A" (thread th1)', undefined, deps, T0 + 2 * MINUTE);
  assert.equal(outcome, 'queued');
  assert.equal(posts.length, 1);
  await withMondayEnabled(async () => {
    assert.equal(await flushDueFeedUpdates(db, T0 + 30 * MINUTE, deps), 1);
  });
  assert.match(posts[1].body, /Halfway there<br>— posted by Nexus on behalf of Nexus task &quot;A&quot; \(thread th1\)/);
  db.close();
});
