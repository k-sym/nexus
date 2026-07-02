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
import { getDb } from '../db.js';
import { insertMission, getMission } from '../missions/store.js';
import { runMissionOnce } from '../missions/runner.js';

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

/**
 * A fake session whose getSessionStats() reports cumulative input/output
 * counters that advance by a fixed delta per prompt(). Used to verify the
 * handler reports per-turn spend (issue #96), not context-window occupancy.
 */
function makeFakeSession(opts: { inputDelta?: number; outputDelta?: number } = {}) {
  const inputDelta = opts.inputDelta ?? 1000;
  const outputDelta = opts.outputDelta ?? 500;
  let input = 0;
  let output = 0;
  return {
    prompt: async (_text: string) => { input += inputDelta; output += outputDelta; },
    getSessionStats: () => ({ tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output } }),
    abort: async () => {},
  };
}

const fakeSession = makeFakeSession({ inputDelta: 3000, outputDelta: 1242 });
const fakePi = { sessionFor: async (_t: string, _cwd: string) => fakeSession } as any;

/** A fake concurrency tracker that always grants the project-wide claim. */
function makeGrantingConcurrency() {
  const owner = Symbol('test-owner');
  return {
    claimProject: (_projectId: string, _threadId: string, _title: string) => owner,
    releaseProject: (_projectId: string, _owner: symbol) => true,
  } as any;
}

// ── Test 1: happy path ────────────────────────────────────────────────────────

test('assistant_turn: happy path → succeeded, tokensUsed = per-turn input+output spend', async () => {
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
    // fakeSession reports input delta 3000 + output delta 1242 = 4242 per turn.
    assert.equal(outcome.tokensUsed, 4242, `expected tokensUsed=4242 (3000 in + 1242 out), got ${outcome.tokensUsed}`);
    assert.ok(outcome.summary?.includes('tokens spent'), `summary should mention spend, got: ${outcome.summary}`);
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
    mkdirSync(join(nexusDir, 'tauri'), { recursive: true });
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
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
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
      claimProject: () => undefined, // always busy
      releaseProject: () => true,
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

// ── Test 10: multi-iteration spend accumulation (issue #96) ──────────────────
//
// Drives the runner across two iterations with a fake session whose
// getSessionStats() cumulative input/output counters grow by a fixed delta
// each turn. Verifies mission.tokens_used accumulates the *per-turn spend*
// (input+output delta), not end-of-turn context-window occupancy, and that
// the accumulation is monotonic toward max_tokens.

test('assistant_turn + runner: multi-iteration tokens_used accumulates per-turn spend, not context occupancy', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'nexus-at-spend-'));
  const dbPath = join(tmpdir(), `nexus-at-spend-${process.pid}-${Date.now()}.db`);
  let db: Database.Database | undefined;
  try {
    db = getDb(dbPath);
    db.prepare(
      "INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES ('p1','p1','P','', ?, '{}',0,'', ?, ?)",
    ).run(repoDir, new Date().toISOString(), new Date().toISOString());

    // Fake session: cumulative input grows 1000/turn, output 500/turn.
    // Per-turn spend delta = 1500 each iteration. Context-window occupancy
    // would instead grow monotonically (e.g. 1500, 3000, ...) and summing it
    // across iterations would double-count retained context.
    let input = 0;
    let output = 0;
    const spendSession = {
      prompt: async (_text: string) => { input += 1000; output += 500; },
      getSessionStats: () => ({ tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output } }),
      abort: async () => {},
    };
    const spendPi = { sessionFor: async () => spendSession } as any;
    const grantingConcurrency = {
      claimProject: () => Symbol('test'),
      releaseProject: () => true,
    } as any;

    const m = insertMission(db, {
      project_id: 'p1', title: 'spend mission', description: '', kind: 'assistant_turn',
      config_json: JSON.stringify({ prompt: 'do work' }), pacing: 'fixed', interval_seconds: 1,
      max_iterations: 10, max_wall_clock_seconds: null, max_tokens: 3000,
      run_window_start: null, run_window_end: null, status: 'active',
      next_run_at: new Date().toISOString(), started_at: new Date().toISOString(),
    });

    const deps = { pi: spendPi, concurrency: grantingConcurrency };

    // Iteration 1: per-turn spend = 1500.
    const r1 = await runMissionOnce(db, getMission(db, m.id)!, deps);
    assert.equal(r1.run!.status, 'succeeded');
    assert.equal(r1.run!.tokens_used, 1500, `iter 1 per-turn spend should be 1500, got ${r1.run!.tokens_used}`);
    assert.equal(r1.mission.tokens_used, 1500);

    // Iteration 2: per-turn spend = 1500 again (NOT 3000, which context
    // occupancy would report). Cumulative = 3000, which hits max_tokens.
    const r2 = await runMissionOnce(db, getMission(db, m.id)!, deps);
    assert.equal(r2.run!.status, 'succeeded');
    assert.equal(r2.run!.tokens_used, 1500, `iter 2 per-turn spend should be 1500, got ${r2.run!.tokens_used}`);
    assert.equal(r2.mission.tokens_used, 3000);
    // Cumulative spend hit the max_tokens ceiling → mission stops.
    assert.equal(r2.mission.status, 'stopped');
    assert.equal(r2.mission.stop_reason, 'token_budget');
  } finally {
    db?.close();
    for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 11: project-wide concurrency claim blocks a same-project chat slot ──
//
// Verifies at the handler + tracker level (no Fastify) that a mission holding
// the project-wide slot prevents a per-(project,model) claim from coexisting
// in the route layer's acquisition order. Mirrors the route-level test in
// routes-chat.test.ts but exercises the real ConcurrencyTracker.

test('assistant_turn: project-wide claim mutually excludes with a per-model claim on the same project', async () => {
  const { ConcurrencyTracker } = await import('../pi/concurrency.js');
  const t = new ConcurrencyTracker();
  // Mission claims the project-wide slot.
  const missionOwner = t.claimProject('proj-x', 'mission-thread', 'Mission');
  assert.ok(missionOwner);
  // A chat turn on an explicit model in the SAME project: the route acquires
  // project-wide first, so it must fail here (this is the route's check).
  assert.equal(t.claimProject('proj-x', 'chat-thread', 'Chat'), undefined, 'project-wide slot must be held by the mission');
  // And conversely, while the mission holds the project slot, the per-model
  // primitive itself is independent (chat would only reach it after the
  // project claim succeeds). The mutual-exclusion is enforced at the
  // project-wide layer, which is the whole point of issue #95.
  t.releaseProject('proj-x', missionOwner);
  // After release, a chat turn can claim the project slot again.
  assert.ok(t.claimProject('proj-x', 'chat-thread', 'Chat'));
});
