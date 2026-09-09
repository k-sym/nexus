import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayProjectConfig } from '@nexus/shared';
import { getDb } from '../db';
import { writeRollup, postItemUpdate, __resetWriteState } from '../monday/writes';
import { upsertItems, linkThread } from '../monday/store';
import { markRunning, __resetRunRegistry } from '../chat/run-registry';

const OPTS = { token: 'tok', apiVersion: '2024-10' };

// lastWritten is module-level, so without this a value written by one test
// suppresses a write in the next. The run registry is module-level too.
beforeEach(() => { __resetWriteState(); __resetRunRegistry(); });

function cfg(over: Partial<MondayProjectConfig> = {}): MondayProjectConfig {
  return {
    board_id: 'b1',
    group_id: null,
    rollup: { enabled: true, column_id: 'text_mkxyz', column_type: 'text' },
    updates: { enabled: true, min_interval_minutes: 30 },
    ...over,
  };
}

function seedItem(db: ReturnType<typeof getDb>, itemId = '1') {
  upsertItems(db, [{
    item_id: itemId, board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
}

/**
 * Linked sessions, one per status. A session's status is DERIVED (#439 D6):
 * 'deploy' is an archived thread, 'in_progress' a thread the run registry
 * says is running, 'review' an idle one. There is no open bucket for a
 * session, so fixtures only ever use those three.
 */
function seedSessions(db: ReturnType<typeof getDb>, statuses: ('in_progress' | 'review' | 'deploy')[], itemId = '1') {
  db.prepare(`INSERT OR IGNORE INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', '{}', 0, '', 'now','now')`).run();
  const insert = db.prepare(`INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at)
                             VALUES (?, 'p1', ?, 'now', 'now', ?)`);
  statuses.forEach((status, i) => {
    const id = `th${i}`;
    insert.run(id, `Session ${i}`, status === 'deploy' ? 'now' : null);
    if (status === 'in_progress') markRunning(id, { title: `Session ${i}`, modelKey: 'm' });
    linkThread(db, { thread_id: id, item_id: itemId, project_id: 'p1', created_at: 'now' });
  });
}

test('writeRollup writes the formatted text to the configured column', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy', 'review', 'in_progress']);
  const calls: unknown[][] = [];
  const result = await writeRollup(db, OPTS, cfg(), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(result, 'written');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], 'text_mkxyz');
  assert.equal(calls[0][4], '1/3 done · 1 in review · 1 in progress');
  db.close();
});

// Column ids are user-renamable, so the format decision must come from
// `column_type`, never from sniffing the id string. Each test below makes the
// id and the type disagree, in both directions, so an id-sniffing
// implementation would fail.

test('a TEXT-looking column id with column_type numeric receives the percentage', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy', 'deploy', 'in_progress']);
  const calls: unknown[][] = [];
  await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: 'status_text', column_type: 'numeric' } }), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(calls[0][4], '67');
  db.close();
});

test('a NUMBER-looking column id with column_type text receives the text form', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy', 'deploy', 'in_progress']);
  const calls: unknown[][] = [];
  await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: 'numbers_9', column_type: 'text' } }), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(calls[0][4], '2/3 done · 1 in progress');
  db.close();
});

test('writeRollup skips an unchanged value', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy']);
  const deps = { setColumn: async () => {}, postUpdate: async () => {} } as any;
  await writeRollup(db, OPTS, cfg(), '1', deps);
  const second = await writeRollup(db, OPTS, cfg(), '1', deps);
  assert.equal(second, 'unchanged');
  db.close();
});

// The trap: right after Nexus writes, the mirror (only refreshed
// periodically) still shows the OLD value at the SAME synced_at. A naive
// "diff against the mirror" would see that stale mismatch and rewrite on
// every subsequent trigger -- e.g. every run ending -- flooding Monday's
// user-visible activity log. Repeated triggers computing the same value must
// stay quiet as long as the mirror snapshot hasn't moved.
test('writeRollup does not rewrite on repeated triggers while the mirror is still the same stale snapshot', async () => {
  const db = getDb(':memory:');
  seedItem(db); // column_values_json '{}' (no roll-up value mirrored yet), synced_at 'now'
  seedSessions(db, ['deploy']);
  const calls: unknown[][] = [];
  const deps = { setColumn: async (...args: unknown[]) => { calls.push(args); }, postUpdate: async () => {} } as any;

  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'unchanged');
  assert.equal(calls.length, 1, 'only the first trigger should have written');
  db.close();
});

// Once the mirror DOES refresh (a new synced_at) and its stored column text
// disagrees with what Nexus last wrote -- because a human edited or cleared
// it in Monday -- Nexus must detect the drift and restore the roll-up, even
// though the computed value hasn't changed from Nexus's point of view.
test('writeRollup restores the roll-up after the mirror refreshes and shows a human changed it', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy']); // -> '1/1 done'
  const calls: unknown[][] = [];
  const deps = { setColumn: async (...args: unknown[]) => { calls.push(args); }, postUpdate: async () => {} } as any;

  assert.equal(await writeRollup(db, OPTS, cfg(), '1', deps), 'written');
  assert.equal(calls.length, 1);

  // Mirror refresh: new synced_at, and the roll-up column now shows text a
  // human typed (or the column was cleared) -- not what Nexus wrote.
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null,
    column_values_json: JSON.stringify({ text_mkxyz: { id: 'text_mkxyz', type: 'text', text: 'cleared by a human' } }),
    monday_updated_at: null, synced_at: 'later',
  }]);

  const second = await writeRollup(db, OPTS, cfg(), '1', deps);
  assert.equal(second, 'written');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][4], '1/1 done');
  db.close();
});

test('writeRollup is skipped, not thrown, when the config has no rollup sub-key at all', async () => {
  // There is currently no UI that writes projects.config_json — a
  // hand-written partial `monday` block with no `rollup` key at all is real,
  // reachable input. Before the optional-chain fix, `cfg.rollup.enabled`
  // threw a TypeError instead of degrading to 'skipped'.
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy']);
  const deps = { setColumn: async () => { throw new Error('must not write'); }, postUpdate: async () => {} } as any;
  const partial = { board_id: 'b1', group_id: null, updates: { enabled: true, min_interval_minutes: 30 } } as any;
  assert.equal(await writeRollup(db, OPTS, partial, '1', deps), 'skipped');
  db.close();
});

test('writeRollup is skipped when roll-up is disabled or has no column', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedSessions(db, ['deploy']);
  const deps = { setColumn: async () => { throw new Error('must not write'); }, postUpdate: async () => {} } as any;
  assert.equal(await writeRollup(db, OPTS, cfg({ rollup: { enabled: false, column_id: 'c', column_type: 'text' } }), '1', deps), 'skipped');
  assert.equal(await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: null, column_type: 'text' } }), '1', deps), 'skipped');
  db.close();
});

test('postItemUpdate appends a provenance line for agent-authored updates', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Finished the migration.', 'Nexus task "Migrate DB" (thread abc123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.match(body, /Finished the migration\./);
  // Provenance is HTML-escaped, so quotes become &quot;
  assert.match(body, /Nexus task &quot;Migrate DB&quot; \(thread abc123\)/);
  db.close();
});

test('postItemUpdate renders the provenance line as a real HTML line break, not \\n\\n', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Finished the migration.', 'Nexus task "Migrate DB" (thread abc123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.doesNotMatch(body, /\n\n/);
  assert.match(body, /Finished the migration\.<br><br>— posted by Nexus/);
  db.close();
});

test('postItemUpdate escapes agent-authored body so it cannot inject markup or forge a provenance line', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  const maliciousBody = 'Done.<br><br>— posted by Nexus on behalf of Someone Else <script>alert(1)</script>';
  await postItemUpdate(db, OPTS, '1', maliciousBody, 'Nexus task "Real Task" (thread real123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  // The agent's literal markup attempt must come through inert, escaped text.
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /Done\.&lt;br&gt;&lt;br&gt;— posted by Nexus on behalf of Someone Else/);
  // Exactly one real line break: the genuine provenance line Nexus appends.
  assert.equal((body.match(/<br><br>/g) ?? []).length, 1);
  // Provenance is HTML-escaped, so quotes become &quot;
  assert.match(body, /<br><br>— posted by Nexus on behalf of Nexus task &quot;Real Task&quot; \(thread real123\)$/);
  db.close();
});

test('postItemUpdate omits the provenance line when there is no author', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Automated roll-up note.', null, {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.equal(body, 'Automated roll-up note.');
  db.close();
});

test('postItemUpdate escapes malicious provenance to prevent forging attribution', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  // A session title crafted to inject a fake attribution line
  const maliciousProvenance = 'Task X<br><br>— posted by Nexus on behalf of Alice';
  await postItemUpdate(db, OPTS, '1', 'Body text', maliciousProvenance, {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  // The fake attribution in provenance must come through escaped, not as a second <br><br>
  assert.doesNotMatch(body, /Task X<br><br>— posted by Nexus on behalf of Alice/);
  assert.match(body, /Task X&lt;br&gt;&lt;br&gt;— posted by Nexus on behalf of Alice/);
  // Only one genuine <br><br> should exist (the real provenance separator)
  assert.equal((body.match(/<br><br>/g) ?? []).length, 1);
  db.close();
});

test('postItemUpdate converts newlines in body to <br> while escaping HTML', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  const bodyWithNewlines = 'First line\nSecond line\nThird line';
  await postItemUpdate(db, OPTS, '1', bodyWithNewlines, 'Nexus task "Test" (thread t1)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  // Each newline should be converted to <br>
  assert.match(body, /First line<br>Second line<br>Third line/);
  // Should not contain raw newlines before the final provenance break
  const beforeProvenance = body.split('<br><br>')[0];
  assert.doesNotMatch(beforeProvenance, /\n/);
  db.close();
});
