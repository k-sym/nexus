import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { autoTitleSession, NEW_THREAD_TITLE, shouldAutoTitle } from '../sessions/auto-title';

function threadDb(title: string): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT)');
  db.prepare('INSERT INTO chat_threads (id, title, updated_at) VALUES (?, ?, ?)').run('t1', title, 'then');
  return db;
}

const target = (currentTitle: string) => ({
  table: 'chat_threads' as const,
  id: 't1',
  currentTitle,
  placeholder: NEW_THREAD_TITLE,
});

const PROMPT = 'Add rate limiting to the tickets sync endpoint';

test('shouldAutoTitle only fires on an untouched placeholder with a real prompt', () => {
  assert.equal(shouldAutoTitle(NEW_THREAD_TITLE, NEW_THREAD_TITLE, PROMPT), true);
  assert.equal(shouldAutoTitle('Rate limit work', NEW_THREAD_TITLE, PROMPT), false);
  assert.equal(shouldAutoTitle(NEW_THREAD_TITLE, NEW_THREAD_TITLE, 'hi'), false);
});

test('writes the generated title over the placeholder', async () => {
  const db = threadDb(NEW_THREAD_TITLE);
  const title = await autoTitleSession(db, target(NEW_THREAD_TITLE), PROMPT, {
    generate: async () => 'Rate limit tickets sync',
  });
  assert.equal(title, 'Rate limit tickets sync');
  assert.equal((db.prepare('SELECT title FROM chat_threads WHERE id = ?').get('t1') as any).title, 'Rate limit tickets sync');
});

test('leaves a user-renamed session alone without calling the model', async () => {
  const db = threadDb('My own name');
  let called = false;
  const title = await autoTitleSession(db, target('My own name'), PROMPT, {
    generate: async () => { called = true; return 'Model title'; },
  });
  assert.equal(title, null);
  assert.equal(called, false);
  assert.equal((db.prepare('SELECT title FROM chat_threads WHERE id = ?').get('t1') as any).title, 'My own name');
});

test('a rename landing mid-generation wins the race', async () => {
  const db = threadDb(NEW_THREAD_TITLE);
  const title = await autoTitleSession(db, target(NEW_THREAD_TITLE), PROMPT, {
    generate: async () => {
      db.prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run('Renamed by user', 't1');
      return 'Model title';
    },
  });
  assert.equal(title, null);
  assert.equal((db.prepare('SELECT title FROM chat_threads WHERE id = ?').get('t1') as any).title, 'Renamed by user');
});

test('a model failure leaves the placeholder in place', async () => {
  const db = threadDb(NEW_THREAD_TITLE);
  const title = await autoTitleSession(db, target(NEW_THREAD_TITLE), PROMPT, {
    generate: async () => { throw new Error('daemon unreachable'); },
  });
  assert.equal(title, null);
  assert.equal((db.prepare('SELECT title FROM chat_threads WHERE id = ?').get('t1') as any).title, NEW_THREAD_TITLE);
});

test('does not bump updated_at — naming is not activity', async () => {
  const db = threadDb(NEW_THREAD_TITLE);
  await autoTitleSession(db, target(NEW_THREAD_TITLE), PROMPT, { generate: async () => 'Some title' });
  assert.equal((db.prepare('SELECT updated_at FROM chat_threads WHERE id = ?').get('t1') as any).updated_at, 'then');
});
