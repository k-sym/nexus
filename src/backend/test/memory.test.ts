import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createMemory, searchMemories } from '../memory/store';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      embedding_json TEXT,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

test('searchMemories ranks by query-term frequency', () => {
  const db = makeDb();
  createMemory(db, { project_id: 'p1', content: 'The deployment pipeline uses Docker and Kubernetes' });
  createMemory(db, { project_id: 'p1', content: 'Docker Docker Docker containers everywhere' });
  createMemory(db, { project_id: 'p1', content: 'Completely unrelated note about cooking pasta' });

  const results = searchMemories(db, 'p1', 'docker', 5);
  assert.equal(results.length, 2);
  // Highest frequency match should rank first.
  assert.ok(results[0].content.startsWith('Docker Docker Docker'));
});

test('searchMemories returns nothing when no term matches', () => {
  const db = makeDb();
  createMemory(db, { project_id: 'p1', content: 'Notes about the frontend layout' });

  const results = searchMemories(db, 'p1', 'kubernetes', 5);
  assert.deepEqual(results, []);
});

test('searchMemories scopes results to the project', () => {
  const db = makeDb();
  createMemory(db, { project_id: 'p1', content: 'shared keyword apple' });
  createMemory(db, { project_id: 'p2', content: 'shared keyword apple' });

  const results = searchMemories(db, 'p1', 'apple', 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].project_id, 'p1');
});

test('searchMemories ignores stop words in the query', () => {
  const db = makeDb();
  createMemory(db, { project_id: 'p1', content: 'something about the build process' });

  // Query made entirely of stop words yields no tokens, hence no results.
  const results = searchMemories(db, 'p1', 'the and of', 5);
  assert.deepEqual(results, []);
});
