/**
 * Tests for the assistant_turn mission handler (Task 14).
 * Uses node:test + node:assert/strict.
 * Injects fake pi / concurrency so no real model is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { Mission } from '@nexus/shared';
import { assistantTurnHandler } from '../missions/handlers/assistant-turn.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal in-memory db with a projects table. */
function makeDb(projectId: string, repoPath: string): Database.Database {
  const db = new Database(':memory:');
  db.prepare(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      repo_path TEXT
    )
  `).run();
  db.prepare('INSERT INTO projects (id, repo_path) VALUES (?, ?)').run(projectId, repoPath);
  return db;
}

/** Build a minimal Mission object for the handler. */
function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    project_id: 'proj-1',
    title: 'Test Mission',
    description: '',
    kind: 'assistant_turn',
    config_json: JSON.stringify({ prompt: 'Hello, agent!' }),
    pacing: 'fixed',
    interval_seconds: 3600,
    max_iterations: null,
    max_wall_clock_seconds: null,
    max_tokens: null,
    run_window_start: null,
    run_window_end: null,
    status: 'active',
    iteration_count: 0,
    tokens_used: 0,
    next_run_at: null,
    started_at: new Date().toISOString(),
    last_run_at: null,
    stopped_at: null,
    stop_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Mission;
}

/** A fake session that reports 4242 tokens. */
const fakeSession = {
  prompt: async (_text: string) => {},
  getContextUsage: () => ({ tokens: 4242, contextWindow: 200000, percent: 2 }),
  abort: async () => {},
};

const fakePi = { sessionFor: async (_t: string, _cwd: string) => fakeSession } as any;

/** A fake concurrency tracker that always grants the claim. */
function makeGrantingConcurrency() {
  const owner = Symbol('test-owner');
  return {
    claim: (_projectId: string, _modelKey: string, _threadId: string, _title: string) => owner,
    release: (_projectId: string, _modelKey: string, _owner: symbol) => true,
  } as any;
}

// ── Test 1: happy path ────────────────────────────────────────────────────────

test('assistant_turn: happy path → succeeded, tokensUsed=4242', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({ project_id: 'proj-1' });

    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: new AbortController().signal,
      deps: {
        pi: fakePi,
        concurrency: makeGrantingConcurrency(),
      },
    });

    assert.equal(outcome.status, 'succeeded', `expected succeeded, got: ${outcome.status} (${outcome.error})`);
    assert.equal(outcome.tokensUsed, 4242, `expected tokensUsed=4242, got ${outcome.tokensUsed}`);
    assert.ok(typeof outcome.summary === 'string' && outcome.summary.length > 0, 'summary should be non-empty');
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 2: Nexus self-refusal ────────────────────────────────────────────────

test('assistant_turn: Nexus self-guard → failed with error "refusing to run agent on Nexus itself"', async () => {
  // Build a fake Nexus-shaped directory with the required markers.
  const nexusDir = mkdtempSync(join(tmpdir(), 'nexus-fake-'));
  try {
    mkdirSync(join(nexusDir, 'src', 'memory-daemon'), { recursive: true });
    mkdirSync(join(nexusDir, 'electron'), { recursive: true });
    writeFileSync(join(nexusDir, 'package.json'), JSON.stringify({ name: 'nexus' }));

    const db = makeDb('proj-nexus', nexusDir);
    const mission = makeMission({
      id: 'mission-nexus',
      project_id: 'proj-nexus',
      config_json: JSON.stringify({ prompt: 'Do something on Nexus' }),
    });

    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: new AbortController().signal,
      deps: { pi: fakePi, concurrency: makeGrantingConcurrency() },
    });

    assert.equal(outcome.status, 'failed', `expected failed, got: ${outcome.status}`);
    assert.equal(outcome.error, 'refusing to run agent on Nexus itself');
    db.close();
  } finally {
    rmSync(nexusDir, { recursive: true, force: true });
  }
});

// ── Test 3: abort before start ────────────────────────────────────────────────

test('assistant_turn: abort pre-check → failed with error "aborted", does not throw', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    const controller = new AbortController();
    controller.abort(); // abort BEFORE calling the handler

    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({ project_id: 'proj-1' });

    // Must not reject:
    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: controller.signal,
      deps: { pi: fakePi, concurrency: makeGrantingConcurrency() },
    });

    assert.equal(outcome.status, 'failed', `expected failed, got: ${outcome.status}`);
    assert.ok(
      outcome.error === 'aborted' || (typeof outcome.error === 'string' && outcome.error.includes('abort')),
      `expected error to mention "aborted", got: ${outcome.error}`,
    );
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 3b: in-flight abort → failed with error "aborted", does not throw ────

test('assistant_turn: in-flight abort → failed with error "aborted", does not throw', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    const controller = new AbortController();

    // Deferred: resolves when the test calls rejectPrompt.
    let rejectPrompt!: (err: Error) => void;
    const pendingPrompt = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });

    let abortCalled = false;

    // Fake session: prompt() hangs until abort() rejects the deferred promise.
    const abortableSession = {
      prompt: async (_text: string) => pendingPrompt,
      getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
      abort: async () => {
        abortCalled = true;
        rejectPrompt(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
    };

    const abortablePi = { sessionFor: async () => abortableSession } as any;

    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({ project_id: 'proj-1' });

    // Start the handler (does not await yet) then abort shortly after.
    const handlerPromise = assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: controller.signal,
      deps: { pi: abortablePi, concurrency: makeGrantingConcurrency() },
    });

    // Defer the abort by one microtask so the handler can reach
    // signal.addEventListener before the abort fires.
    await Promise.resolve();
    // Trigger the abort — the handler's abort listener calls session.abort(),
    // which rejects the pending prompt with an AbortError.
    controller.abort();

    // Handler must resolve (not reject) to a failed outcome.
    const outcome = await handlerPromise;

    assert.equal(outcome.status, 'failed', `expected failed, got: ${outcome.status}`);
    assert.equal(outcome.error, 'aborted', `expected error "aborted", got: ${outcome.error}`);
    assert.equal(abortCalled, true, 'session.abort() should have been called during in-flight abort');
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 4: no prompt in config → failed ─────────────────────────────────────

test('assistant_turn: missing prompt → failed with appropriate error', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({
      project_id: 'proj-1',
      config_json: JSON.stringify({}), // no prompt field
    });

    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: new AbortController().signal,
      deps: { pi: fakePi },
    });

    assert.equal(outcome.status, 'failed');
    assert.ok(typeof outcome.error === 'string' && outcome.error.length > 0, 'error should be set');
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 5: no pi runtime → failed ───────────────────────────────────────────

test('assistant_turn: pi runtime absent → failed', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({ project_id: 'proj-1' });

    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: new AbortController().signal,
      deps: {}, // no pi
    });

    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.error?.includes('pi runtime'), `expected pi-runtime error, got: ${outcome.error}`);
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 6: no repo_path → failed ────────────────────────────────────────────

test('assistant_turn: missing repo_path → failed', async () => {
  const db = makeDb('proj-missing', ''); // empty repo_path
  const mission = makeMission({ project_id: 'proj-missing' });

  const outcome = await assistantTurnHandler({
    db,
    mission,
    runNumber: 1,
    signal: new AbortController().signal,
    deps: { pi: fakePi },
  });

  assert.equal(outcome.status, 'failed');
  assert.ok(outcome.error?.includes('repo_path'), `expected repo_path error, got: ${outcome.error}`);
  db.close();
});

// ── Test 7: concurrency busy → failed ────────────────────────────────────────

test('assistant_turn: concurrency busy → failed without calling model', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    let promptCalled = false;
    const watchedSession = {
      ...fakeSession,
      prompt: async (_text: string) => { promptCalled = true; },
    };
    const watchedPi = { sessionFor: async () => watchedSession } as any;

    const busyConcurrency = {
      claim: () => undefined, // always busy
      release: () => true,
    } as any;

    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({ project_id: 'proj-1' });

    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: new AbortController().signal,
      deps: { pi: watchedPi, concurrency: busyConcurrency },
    });

    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.error?.includes('busy'), `expected busy error, got: ${outcome.error}`);
    assert.equal(promptCalled, false, 'prompt should not have been called when concurrency busy');
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 8: happy path without concurrency tracker ───────────────────────────

test('assistant_turn: no concurrency tracker → still succeeds', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-test-'));
  try {
    const db = makeDb('proj-1', repoDir);
    const mission = makeMission({ project_id: 'proj-1' });

    const outcome = await assistantTurnHandler({
      db,
      mission,
      runNumber: 1,
      signal: new AbortController().signal,
      deps: { pi: fakePi }, // no concurrency
    });

    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.tokensUsed, 4242);
    db.close();
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
