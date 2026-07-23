import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { composeProjectName, type DockerExec, type ExecResult } from '../docker/compose';
import { describeSweep, liveThreadIds, sweepOrphanedProjects } from '../docker/sweep';

const OK: ExecResult = { stdout: '', stderr: '', code: 0 };

/** A docker stub that reports `projects` from `compose ls` and records downs. */
function dockerWith(projects: string[], downResult: Partial<ExecResult> = {}) {
  const downs: string[] = [];
  const exec: DockerExec = async (args) => {
    if (args[0] === 'compose' && args[1] === 'ls') {
      return { ...OK, stdout: JSON.stringify(projects.map((Name) => ({ Name, Status: 'running(1)' }))) };
    }
    if (args.includes('down')) {
      downs.push(args[args.indexOf('--project-name') + 1]);
      return { ...OK, ...downResult };
    }
    return OK;
  };
  return { exec, downs };
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-sweep-'));
  const db = getDb(join(dir, 'nexus.db'));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertProject(db: ReturnType<typeof tempDb>['db'], id: string) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, id, `Project ${id}`, `/repo/${id}`, now, now);
}

function insertThread(db: ReturnType<typeof tempDb>['db'], id: string, projectId: string) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, 'agent', 'T', now, now);
}

test('liveThreadIds covers chat threads and both mission thread forms', () => {
  const { db, cleanup } = tempDb();
  try {
    insertProject(db, 'p1');
    insertThread(db, 'thread-alive', 'p1');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO missions (id, project_id, title, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m1', 'p1', 'Mission', JSON.stringify({ thread_id: 'pinned-thread' }), now, now);
    db.prepare(
      'INSERT INTO missions (id, project_id, title, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m2', 'p1', 'Mission 2', '{}', now, now);

    const ids = liveThreadIds(db);
    assert.ok(ids.includes('thread-alive'));
    // Missions default to `mission-<id>` but may pin their own thread id; both
    // are live sessions and both must be protected.
    assert.ok(ids.includes('mission-m1'));
    assert.ok(ids.includes('pinned-thread'));
    assert.ok(ids.includes('mission-m2'));
  } finally {
    cleanup();
  }
});

test('a malformed mission config still protects the default thread id', () => {
  const { db, cleanup } = tempDb();
  try {
    insertProject(db, 'p1');
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO missions (id, project_id, title, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m1', 'p1', 'Mission', 'not json at all', now, now);
    assert.ok(liveThreadIds(db).includes('mission-m1'));
  } finally {
    cleanup();
  }
});

test('the sweep removes orphans and keeps live threads', async () => {
  const { db, cleanup } = tempDb();
  try {
    insertProject(db, 'p1');
    insertThread(db, 'thread-alive', 'p1');

    const live = composeProjectName('thread-alive');
    const orphan = composeProjectName('thread-deleted');
    const { exec, downs } = dockerWith([live, orphan]);

    const result = await sweepOrphanedProjects(db, { exec });
    assert.deepEqual(result.removed, [orphan]);
    assert.deepEqual(result.kept, [live]);
    assert.deepEqual(downs, [orphan], 'only the orphan was torn down');
  } finally {
    cleanup();
  }
});

test('the sweep never touches projects it does not own', async () => {
  const { db, cleanup } = tempDb();
  try {
    // `compose ls` is filtered to the nexus- prefix upstream, but assert the
    // end-to-end property: someone else's stack is not ours to remove.
    const { exec, downs } = dockerWith(['someone-elses-postgres', 'my-app-dev']);
    const result = await sweepOrphanedProjects(db, { exec });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(downs, []);
  } finally {
    cleanup();
  }
});

test('an unreadable live set removes nothing', async () => {
  const { db, cleanup } = tempDb();
  try {
    const orphan = composeProjectName('thread-deleted');
    const { exec, downs } = dockerWith([orphan]);
    // Without a trustworthy live set, an orphan and a running thread's stack
    // are indistinguishable — and removing the wrong one is far worse than
    // leaking, so the sweep must do nothing at all.
    const result = await sweepOrphanedProjects(db, {
      exec,
      getLiveThreadIds: () => { throw new Error('db exploded'); },
    });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(downs, [], 'nothing torn down on a bad read');
    assert.deepEqual(result.found, [orphan], 'but it still reports what it saw');
  } finally {
    cleanup();
  }
});

test('the sweep skips entirely when docker is unavailable', async () => {
  const { db, cleanup } = tempDb();
  try {
    const { exec, downs } = dockerWith([composeProjectName('gone')]);
    const result = await sweepOrphanedProjects(db, { exec, isAvailable: () => false });
    assert.deepEqual(result, { found: [], removed: [], kept: [], failed: [] });
    assert.deepEqual(downs, []);
  } finally {
    cleanup();
  }
});

test('a failed teardown is reported, not swallowed, and leaves the rest running', async () => {
  const { db, cleanup } = tempDb();
  try {
    const a = composeProjectName('gone-a');
    const b = composeProjectName('gone-b');
    let calls = 0;
    const exec: DockerExec = async (args) => {
      if (args[1] === 'ls') return { ...OK, stdout: JSON.stringify([{ Name: a }, { Name: b }]) };
      if (args.includes('down')) {
        calls += 1;
        // First one fails; the second must still be attempted.
        return calls === 1 ? { stdout: '', stderr: 'daemon busy', code: 1 } : OK;
      }
      return OK;
    };
    const result = await sweepOrphanedProjects(db, { exec });
    assert.deepEqual(result.failed, [a]);
    assert.deepEqual(result.removed, [b], 'one failure does not abort the sweep');
  } finally {
    cleanup();
  }
});

test('a throwing docker exec is contained per project', async () => {
  const { db, cleanup } = tempDb();
  try {
    const a = composeProjectName('gone-a');
    const exec: DockerExec = async (args) => {
      if (args[1] === 'ls') return { ...OK, stdout: JSON.stringify([{ Name: a }]) };
      throw new Error('spawn failed');
    };
    const result = await sweepOrphanedProjects(db, { exec });
    assert.deepEqual(result.failed, [a]);
    assert.deepEqual(result.removed, []);
  } finally {
    cleanup();
  }
});

test('a listing failure is not an error worth failing startup over', async () => {
  const { db, cleanup } = tempDb();
  try {
    const exec: DockerExec = async () => { throw new Error('daemon gone'); };
    const result = await sweepOrphanedProjects(db, { exec });
    assert.deepEqual(result, { found: [], removed: [], kept: [], failed: [] });
  } finally {
    cleanup();
  }
});

test('describeSweep stays quiet on a clean boot', () => {
  assert.equal(describeSweep({ found: [], removed: [], kept: [], failed: [] }), null);
  assert.equal(describeSweep({ found: ['nexus-a'], removed: [], kept: ['nexus-a'], failed: [] }), null);

  const line = describeSweep({ found: ['nexus-a'], removed: ['nexus-a'], kept: [], failed: ['nexus-b'] });
  assert.match(line ?? '', /removed 1 orphaned service group\(s\): nexus-a/);
  assert.match(line ?? '', /1 could not be removed: nexus-b/);
});
