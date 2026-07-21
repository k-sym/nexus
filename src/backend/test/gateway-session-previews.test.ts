import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildSessions, previewFromEvents } from '../gateway/sessions';

/**
 * The glasses summary list ships a one-line preview per session. Both mapping sites
 * used to hardcode lastPrompt/lastAssistant/turns to empty, so the companion dashboard
 * rendered "0 turns" and no preview for every session, forever.
 *
 * Previews come from the transcript readers, NOT the message tables: `chat_messages`
 * holds only the user side (a thread's replies live in the pi store) and
 * `assistant_session_messages` is empty in practice.
 */

test('a transcript reduces to its latest prompt, latest reply and turn count', () => {
  const p = previewFromEvents([
    { kind: 'user', text: 'first question' },
    { kind: 'assistant_text', text: 'first answer' },
    { kind: 'tool_use' },
    { kind: 'user', text: 'second question' },
    { kind: 'assistant_text', text: 'the most recent answer' },
  ]);
  assert.equal(p.lastPrompt, 'second question');
  assert.equal(p.lastAssistant, 'the most recent answer');
  assert.equal(p.turns, 2); // a turn is a user message; tool calls are not turns
});

test('an empty or reply-less transcript stays empty rather than undefined', () => {
  assert.deepEqual(previewFromEvents([]), { lastPrompt: '', lastAssistant: '', turns: 0 });
  const p = previewFromEvents([{ kind: 'user', text: 'asked but not yet answered' }]);
  assert.equal(p.lastAssistant, '');
  assert.equal(p.turns, 1);
});

test('blank messages do not become the preview', () => {
  const p = previewFromEvents([
    { kind: 'assistant_text', text: 'a real answer' },
    { kind: 'assistant_text', text: '   ' },
    { kind: 'user', text: '' },
  ]);
  assert.equal(p.lastAssistant, 'a real answer', 'a whitespace-only reply must not blank the preview');
  assert.equal(p.turns, 1, 'an empty user message is still a turn');
});

test('previews are flattened and capped', () => {
  assert.equal(
    previewFromEvents([{ kind: 'assistant_text', text: 'line one\n\n   line two\t\tspaced' }]).lastAssistant,
    'line one line two spaced',
  );
  const long = previewFromEvents([{ kind: 'assistant_text', text: 'x'.repeat(1000) }]).lastAssistant;
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'), 'a cut preview says so');
});

// --- wiring ---------------------------------------------------------------

const NOW = new Date().toISOString();

function db(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, badge TEXT NOT NULL DEFAULT '', repo_path TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, project_id TEXT, archived_at TEXT);
    CREATE TABLE assistant_sessions (id TEXT PRIMARY KEY, title TEXT, status TEXT, updated_at TEXT, archived_at TEXT);
    CREATE TABLE assistant_runs (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, started_at TEXT, updated_at TEXT);
    INSERT INTO projects VALUES ('p1', 'nexus', 'NEX', '/repo');
  `);
  d.prepare('INSERT INTO chat_threads VALUES (?, ?, ?, ?, NULL)').run('t1', 'Session', NOW, 'p1');
  return d;
}

/** A pi stub that records how many transcript reads the list actually costs. */
function countingPi() {
  const calls: string[] = [];
  return { calls, pi: { readMessages: async (id: string) => { calls.push(id); return []; } } as never };
}

test('a transcript is read once per session and then cached until it changes', async () => {
  const d = db();
  const { calls, pi } = countingPi();
  const deps = { db: d as never, pi, mainPort: 1, recentMs: 60_000 };

  await buildSessions(deps, 'all');
  assert.equal(calls.length, 1);

  await buildSessions(deps, 'all');
  assert.equal(calls.length, 1, 'unchanged session must not be re-read on the next poll');

  // New activity moves the timestamp, which is the cache key.
  d.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(new Date(Date.now() + 1000).toISOString(), 't1');
  await buildSessions(deps, 'all');
  assert.equal(calls.length, 2, 'a session that moved must be re-read');
});

test('a chat session carries its project rail badge', async () => {
  const d = db();
  const { pi } = countingPi();
  const [s] = await buildSessions({ db: d as never, pi, mainPort: 1, recentMs: 60_000 }, 'all');
  assert.equal(s.projectBadge, 'NEX', 'the lens rail should read the same badge as the desktop rail');
});

test('a project with no badge yet leaves it unset for the client to derive', async () => {
  const d = db();
  d.prepare("UPDATE projects SET badge = '' WHERE id = 'p1'").run();
  const { pi } = countingPi();
  const [s] = await buildSessions({ db: d as never, pi, mainPort: 1, recentMs: 60_000 }, 'all');
  assert.equal(s.projectBadge, undefined);
});

test('buildSessions can skip previews entirely', async () => {
  const d = db();
  const { calls, pi } = countingPi();
  const sessions = await buildSessions({ db: d as never, pi, mainPort: 1, recentMs: 60_000 }, 'all', { previews: false });
  assert.equal(calls.length, 0, 'detail serves one session and must not read every transcript');
  assert.equal(sessions[0].turns, 0);
});
