import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { PiRuntime, type PiRuntimePaths } from '../pi/runtime';
import {
  archiveThreadToMemory,
  buildTranscriptWindows,
  selectWindows,
  ArchiveThreadError,
  type ArchiveSettings,
} from '../sessions/archive';

// A transcript that forces multi-pass with one window per message: each message line
// is under `max_single_pass_chars` but any two joined exceed it. The last message
// carries a distinctive token so tests can prove the session's *ending* survives.
const MESSAGES = [
  { role: 'user', content: 'alpha padding line one here' },
  { role: 'assistant', content: 'beta padding line two here' },
  { role: 'user', content: 'gamma padding line three here' },
  { role: 'assistant', content: 'delta padding line four here' },
  { role: 'user', content: 'epsilon DECISIONZZZ five here' },
];

function makeDb(messages: Array<{ role: string; content: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-archive-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, archived_at TEXT);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO projects (id, slug, name, repo_path) VALUES (?,?,?,?)').run('proj-1', 'demo', 'Demo', dir);
  db.prepare('INSERT INTO chat_threads (id, project_id, title) VALUES (?,?,?)').run('thread-1', 'proj-1', 'T1');
  const insert = db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?,?,?,?,?)');
  messages.forEach((m, i) => insert.run(`msg-${i}`, 'thread-1', m.role, m.content, new Date(2026, 0, 1, 0, 0, i).toISOString()));
  return { db, dir };
}

// pi stub: force the DB-transcript fallback (readMessages throws) and record drops.
function stubPi(dropCalls: Array<{ threadId: string; opts?: { tombstoneRetentionDays?: number } }>) {
  return {
    readMessages: async () => { throw new Error('no pi session (test uses db fallback)'); },
    dropSession: (threadId: string, _cwd: string, opts?: { tombstoneRetentionDays?: number }) => {
      dropCalls.push({ threadId, opts });
    },
  } as unknown as PiRuntime;
}

const SETTINGS = (over: Partial<ArchiveSettings> = {}): ArchiveSettings => ({
  max_single_pass_chars: 60,
  max_chunks: 6,
  summary_target_tokens: 800,
  undo_retention_days: 30,
  ...over,
});

// A recording mode-aware summariser. chunk notes tag whether they saw the decision;
// synthesis folds the notes it was given, so a decision from the last window flows
// through to the final summary.
function recordingWindow(calls: Array<{ mode: string; text: string }>) {
  return async ({ mode, text }: { mode: string; text: string }) => {
    calls.push({ mode, text });
    if (mode === 'chunk') return `note<${text.includes('DECISIONZZZ') ? 'DECISIONZZZ' : 'x'}>`;
    if (mode === 'synthesis') return `SUMMARY :: ${text}`;
    return `SINGLE :: ${text}`;
  };
}

test('buildTranscriptWindows keeps small transcripts whole', () => {
  assert.deepEqual(buildTranscriptWindows('short enough', 100), ['short enough']);
});

test('buildTranscriptWindows splits on message boundaries', () => {
  assert.deepEqual(buildTranscriptWindows('a\n\nb\n\nc', 1), ['a', 'b', 'c']);
});

test('buildTranscriptWindows hard-splits a paragraph larger than a window', () => {
  assert.deepEqual(buildTranscriptWindows('abcdef', 2), ['ab', 'cd', 'ef']);
});

test('selectWindows keeps head + tail and flags elision past the cap', () => {
  assert.deepEqual(selectWindows(['1', '2', '3'], 6), { selected: ['1', '2', '3'], elided: false });
  // Tail is always kept, so the session ending survives.
  assert.deepEqual(selectWindows(['1', '2', '3', '4', '5'], 2), { selected: ['1', '5'], elided: true });
});

// A1 + A7: an oversized session rolls up; a decision present ONLY in the final window
// reaches the summary, and the pass count is bounded to (chunks + 1 synthesis).
test('archive roll-up surfaces a decision from the final window (A1, A7)', async () => {
  const { db } = makeDb(MESSAGES);
  const drops: Array<{ threadId: string; opts?: { tombstoneRetentionDays?: number } }> = [];
  const calls: Array<{ mode: string; text: string }> = [];
  const stored: any[] = [];

  const result = await archiveThreadToMemory(db, stubPi(drops), 'thread-1', {
    settings: SETTINGS(),
    summarizeWindow: recordingWindow(calls),
    storeMemory: async (input) => { stored.push(input); return { id: 'mem-1' }; },
  });

  assert.equal(result.elided, false);
  assert.match(stored[0].content, /DECISIONZZZ/); // the ending was not dropped
  // 5 windows → 5 chunk passes + 1 synthesis; last call is the synthesis.
  const modes = calls.map((c) => c.mode);
  assert.equal(modes.filter((m) => m === 'chunk').length, 5);
  assert.equal(modes.filter((m) => m === 'synthesis').length, 1);
  assert.equal(calls.length, 6);
  assert.equal(calls[calls.length - 1].mode, 'synthesis');
  db.close();
});

// A4: past max_chunks, the summary is marked elided and carries an explicit in-body
// note, while the tail (with the decision) is still summarised.
test('archive marks elision with an in-body note past max_chunks (A4)', async () => {
  const { db } = makeDb(MESSAGES);
  const drops: Array<{ threadId: string; opts?: { tombstoneRetentionDays?: number } }> = [];
  const calls: Array<{ mode: string; text: string }> = [];
  const stored: any[] = [];

  const result = await archiveThreadToMemory(db, stubPi(drops), 'thread-1', {
    settings: SETTINGS({ max_chunks: 2 }),
    summarizeWindow: recordingWindow(calls),
    storeMemory: async (input) => { stored.push(input); return { id: 'mem-1' }; },
  });

  assert.equal(result.elided, true);
  assert.equal(stored[0].metadata.elided, true);
  assert.match(stored[0].content, /^> _Note: this session was long/);
  assert.match(stored[0].content, /DECISIONZZZ/); // tail still summarised
  assert.equal(calls.filter((c) => c.mode === 'chunk').length, 2); // head + tail only
  db.close();
});

// Backward compatibility: an in-budget transcript takes the single-pass path via
// `summarize`, and the multi-pass window summariser is never called.
test('archive uses single-pass summarize for in-budget transcripts', async () => {
  const { db } = makeDb(MESSAGES);
  const drops: Array<{ threadId: string; opts?: { tombstoneRetentionDays?: number } }> = [];
  const windowCalls: Array<{ mode: string; text: string }> = [];
  let singleCalls = 0;

  const result = await archiveThreadToMemory(db, stubPi(drops), 'thread-1', {
    settings: SETTINGS({ max_single_pass_chars: 100_000 }),
    summarize: async () => { singleCalls++; return 'One-pass structured summary.'; },
    summarizeWindow: recordingWindow(windowCalls),
    storeMemory: async () => ({ id: 'mem-1' }),
  });

  assert.equal(result.elided, false);
  assert.equal(singleCalls, 1);
  assert.equal(windowCalls.length, 0);
  db.close();
});

// Regression for the silent metadata drop: with no storeMemory stub, the archive
// goes through the real addMemory → daemon.store path, and the daemon must receive
// thread_id/thread_title/elided (they used to vanish before reaching the daemon).
test('archive forwards metadata through the real daemon store path', async () => {
  const { db } = makeDb(MESSAGES);
  const drops: Array<{ threadId: string; opts?: { tombstoneRetentionDays?: number } }> = [];

  const storeBodies: any[] = [];
  const daemon = Fastify({ logger: false });
  daemon.post('/memories', async (req, reply) => {
    storeBodies.push(req.body);
    return reply.code(201).send({ id: 'mem-real-1', action: 'insert' });
  });
  await daemon.listen({ host: '127.0.0.1', port: 0 });
  const address = daemon.server.address() as { port: number };
  const previousUrl = process.env.MEMORY_DAEMON_URL;
  process.env.MEMORY_DAEMON_URL = `http://127.0.0.1:${address.port}`;

  try {
    const result = await archiveThreadToMemory(db, stubPi(drops), 'thread-1', {
      settings: SETTINGS({ max_single_pass_chars: 100_000 }),
      summarize: async () => 'One-pass structured summary.',
    });

    assert.equal(result.memoryId, 'mem-real-1');
    assert.equal(storeBodies.length, 1);
    assert.equal(storeBodies[0].source, 'nexus:session-archive');
    assert.equal(storeBodies[0].category, 'session_archive');
    assert.deepEqual(storeBodies[0].metadata, {
      thread_id: 'thread-1',
      thread_title: 'T1',
      elided: false,
    });
  } finally {
    if (previousUrl === undefined) delete process.env.MEMORY_DAEMON_URL;
    else process.env.MEMORY_DAEMON_URL = previousUrl;
    await daemon.close();
    db.close();
  }
});

// A6: a summariser failure returns 502 and leaves the thread intact — no delete, no
// tombstone.
test('archive keeps the thread intact when summarisation fails (A6)', async () => {
  const { db } = makeDb(MESSAGES);
  const drops: Array<{ threadId: string; opts?: { tombstoneRetentionDays?: number } }> = [];

  await assert.rejects(
    () => archiveThreadToMemory(db, stubPi(drops), 'thread-1', {
      settings: SETTINGS({ max_single_pass_chars: 100_000 }),
      summarize: async () => { throw new ArchiveThreadError(502, 'Memory daemon archive summary failed'); },
      storeMemory: async () => { throw new Error('store must not run'); },
    }),
    (err: unknown) => err instanceof ArchiveThreadError && err.statusCode === 502,
  );

  const row = db.prepare('SELECT COUNT(*) AS c FROM chat_threads WHERE id = ?').get('thread-1') as { c: number };
  assert.equal(row.c, 1);
  assert.equal(drops.length, 0);
  db.close();
});

// A5: archiving tombstones the raw .jsonl for the undo window; the sweep purges it
// only once expired. Retention 0 hard-deletes immediately.
test('dropSession tombstones the raw session and the sweep purges on expiry (A5)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-tomb-test-'));
  const paths: PiRuntimePaths = { authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') };
  const pi = await PiRuntime.create(paths);
  const cwd = dir;
  const sessionDir = pi.sessionDirFor(cwd);
  mkdirSync(sessionDir, { recursive: true });

  // Retention > 0 → tombstone into .trash rather than unlink.
  const keep = '20260101_120000_thread-keep.jsonl';
  writeFileSync(join(sessionDir, keep), '{"m":1}\n');
  pi.dropSession('thread-keep', cwd, { tombstoneRetentionDays: 30 });
  assert.equal(existsSync(join(sessionDir, keep)), false);
  assert.equal(existsSync(join(sessionDir, '.trash', keep)), true);

  // Fresh tombstone survives a sweep; an aged one is purged.
  assert.equal(pi.sweepExpiredTombstones(30), 0);
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(join(sessionDir, '.trash', keep), old, old);
  assert.equal(pi.sweepExpiredTombstones(30), 1);
  assert.equal(existsSync(join(sessionDir, '.trash', keep)), false);

  // Retention 0 → immediate hard delete, no tombstone (the thread-delete path).
  const gone = '20260101_120000_thread-gone.jsonl';
  writeFileSync(join(sessionDir, gone), '{"m":1}\n');
  pi.dropSession('thread-gone', cwd, { tombstoneRetentionDays: 0 });
  assert.equal(existsSync(join(sessionDir, gone)), false);
  assert.equal(existsSync(join(sessionDir, '.trash', gone)), false);
});
