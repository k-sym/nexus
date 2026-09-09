delete process.env.MONDAY_TOKEN;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerMondayThreadHooks, onThreadArchived, onThreadLinked, type ThreadHookDeps } from '../monday/thread-hooks';
import { __resetWriteState } from '../monday/writes';
import { __resetStatusSyncState } from '../monday/status-sync';
import { upsertItems, linkThread } from '../monday/store';
import { markRunning, markStopped, __resetRunRegistry } from '../chat/run-registry';
import { loadConfig, saveConfig } from '../config';
import type { ActivityEvent } from '../activity/events';

// saveConfig writes config.yaml for real; point the whole ~/.nexus tree at a
// scratch dir first (config.ts reads NEXUS_HOME on every call).
const NEXUS_HOME = mkdtempSync(join(tmpdir(), 'nexus-monday-thread-hooks-home-'));
process.env.NEXUS_HOME = NEXUS_HOME;
after(() => rmSync(NEXUS_HOME, { recursive: true, force: true }));

beforeEach(() => { __resetWriteState(); __resetStatusSyncState(); __resetRunRegistry(); });

const COLUMN = 'color_1';

/** Roll-up, status sync and the updates feed all on, so every hook has
 *  something to write and the test can see which of the three fired. */
function seed(db: ReturnType<typeof getDb>, statusText: string | null = null) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: true, min_interval_minutes: 30 },
        status_sync: {
          enabled: true, column_id: COLUMN, forward_only: true,
          mapping: { in_progress: 'In flight', review: 'Near done', deploy: 'Complete' },
        },
      },
    }));
  db.prepare(`INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at)
              VALUES ('linked','p1','Fix the thing','now','now',NULL)`).run();
  db.prepare(`INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at)
              VALUES ('loose','p1','Unlinked chat','now','now',NULL)`).run();
  upsertItems(db, [{
    item_id: 'i1', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: statusText, status_color: null,
    owners_json: '[]', url: null,
    column_values_json: statusText === null ? '{}' : JSON.stringify({ [COLUMN]: { id: COLUMN, type: 'status', text: statusText } }),
    monday_updated_at: null, synced_at: 'now',
  }]);
  linkThread(db, { thread_id: 'linked', item_id: 'i1', project_id: 'p1', created_at: 'now' });
}

interface Captured {
  deps: ThreadHookDeps;
  columns: unknown[][];
  statuses: unknown[][];
  posts: string[];
}

/** Injected writers: nothing here touches the network. */
function capture(): Captured {
  const columns: unknown[][] = [];
  const statuses: unknown[][] = [];
  const posts: string[] = [];
  return {
    columns, statuses, posts,
    deps: {
      rollup: { setColumn: async (...args: unknown[]) => { columns.push(args); }, postUpdate: async () => {} } as never,
      status: { setStatus: async (...args: unknown[]) => { statuses.push(args); } } as never,
      feed: { postUpdate: async (_opts, _itemId, body) => { posts.push(body); } },
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

/** The hooks are fire-and-forget; wait for the three writes to settle. */
async function settle(events: ActivityEvent[], stops: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (events.filter((e) => e.type === 'stop').length < stops) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; got ${JSON.stringify(events)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a run stopping for a linked thread rolls up, syncs status, and posts a Review move', async () => {
  const db = getDb(':memory:');
  seed(db);
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    const unsubscribe = registerMondayThreadHooks(db, (e) => events.push(e), cap.deps);
    markRunning('linked', { title: 'Fix the thing', modelKey: 'm' });
    assert.equal(events.length, 0, 'a run STARTING must not write to Monday');
    markStopped('linked');
    await settle(events, 3);
    unsubscribe();
  });
  assert.deepEqual(
    events.filter((e) => e.type === 'start').map((e) => e.title).sort(),
    ['Monday roll-up', 'Monday status', 'Monday update'],
  );
  assert.ok(events.every((e) => e.taskId === 'linked' && e.threadId === 'linked'), 'the thread id rides both event slots');
  // Stopped and not archived → the session is in review (#439 D6).
  assert.equal(cap.columns[0][4], '0/1 done · 1 in review');
  assert.equal(cap.statuses[0][4], 'Near done');
  assert.equal(cap.posts[0], '<b>Nexus</b> · 1 session moved<br>• Fix the thing → Review');
  db.close();
});

test('a run stopping for an unlinked thread writes nothing', async () => {
  const db = getDb(':memory:');
  seed(db);
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    const unsubscribe = registerMondayThreadHooks(db, (e) => events.push(e), cap.deps);
    markRunning('loose', { title: 'Unlinked chat', modelKey: 'm' });
    markStopped('loose');
    await new Promise((r) => setTimeout(r, 30));
    unsubscribe();
  });
  assert.equal(events.length, 0);
  assert.equal(cap.posts.length, 0);
  db.close();
});

test('the run-end hook does not advance an item off a label a human is holding', async () => {
  const db = getDb(':memory:');
  seed(db, 'Wants attention');
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    const unsubscribe = registerMondayThreadHooks(db, (e) => events.push(e), cap.deps);
    markRunning('linked', { title: 'Fix the thing', modelKey: 'm' });
    markStopped('linked');
    await settle(events, 3);
    unsubscribe();
  });
  assert.equal(cap.statuses.length, 0, 'no status write off an unmanaged label');
  assert.equal(events.find((e) => e.title === 'Monday status' && e.type === 'stop')!.lastEvent, 'skipped');
  assert.equal(cap.columns.length, 1, 'the roll-up still writes');
  db.close();
});

test('unsubscribing stops the hook listening to the registry', async () => {
  const db = getDb(':memory:');
  seed(db);
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    const unsubscribe = registerMondayThreadHooks(db, (e) => events.push(e), cap.deps);
    unsubscribe();
    markRunning('linked', { title: 'Fix the thing', modelKey: 'm' });
    markStopped('linked');
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(events.length, 0);
  db.close();
});

test('onThreadArchived rolls up as done, syncs Complete, and posts a Done move', async () => {
  const db = getDb(':memory:');
  seed(db);
  db.prepare("UPDATE chat_threads SET archived_at = 'now' WHERE id = 'linked'").run();
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    onThreadArchived(db, 'linked', (e) => events.push(e), cap.deps);
    await settle(events, 3);
  });
  assert.equal(cap.columns[0][4], '1/1 done');
  assert.equal(cap.statuses[0][4], 'Complete');
  assert.equal(cap.posts[0], '<b>Nexus</b> · 1 session moved<br>• Fix the thing → Done');
  db.close();
});

test('onThreadArchived is a silent no-op for an unlinked thread', async () => {
  const db = getDb(':memory:');
  seed(db);
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    onThreadArchived(db, 'loose', (e) => events.push(e), cap.deps);
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(events.length, 0);
  db.close();
});

test('onThreadLinked is the ownership handoff: it may advance off an unmanaged label, and posts no feed move', async () => {
  const db = getDb(':memory:');
  seed(db, 'Wants attention');
  const cap = capture();
  const events: ActivityEvent[] = [];
  await withMondayEnabled(async () => {
    onThreadLinked(db, 'linked', (e) => events.push(e), cap.deps);
    await settle(events, 2);
  });
  assert.deepEqual(events.filter((e) => e.type === 'start').map((e) => e.title).sort(), ['Monday roll-up', 'Monday status']);
  assert.equal(cap.statuses[0][4], 'Near done', 'link-create advances the item off the inbox label');
  assert.equal(cap.posts.length, 0, 'a link is not a stage the feed narrates');
  db.close();
});

test('the hooks never throw, even against a DB that predates the Monday tables', async () => {
  const bare = new Database(':memory:');
  assert.doesNotThrow(() => onThreadArchived(bare, 't1'));
  assert.doesNotThrow(() => onThreadLinked(bare, 't1'));
  const unsubscribe = registerMondayThreadHooks(bare);
  assert.doesNotThrow(() => { markRunning('t1', { title: 'x', modelKey: 'm' }); markStopped('t1'); });
  await new Promise((r) => setTimeout(r, 20));
  unsubscribe();
  bare.close();
});
