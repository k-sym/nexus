import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { getDb } from '../db';
import { composeProjectName, type DockerExec, type ExecResult } from '../docker/compose';
import { listServiceGroups, parsePsLine } from '../docker/services';
import { registerDockerRoutes } from '../routes/docker';

const OK: ExecResult = { stdout: '', stderr: '', code: 0 };
const PS_LINE = (project: string, name: string, state = 'running', status = 'Up 1 minute', ports = '0.0.0.0:5432->5432/tcp', image = 'postgres:16') =>
  [project, name, state, status, ports, image].join('\t');

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-docker-ui-'));
  const db = getDb(join(dir, 'nexus.db'));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertThread(db: Database.Database, id: string) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('p1', 'p1', 'P', '/repo', now, now);
  db.prepare('INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'p1', 'agent', 'T', now, now);
}

test('parsePsLine parses a well-formed row and rejects a short one', () => {
  const parsed = parsePsLine(PS_LINE('nexus-t1', 'nexus-t1-web-1'));
  assert.equal(parsed?.project, 'nexus-t1');
  assert.equal(parsed?.name, 'nexus-t1-web-1');
  assert.equal(parsed?.state, 'running');
  assert.equal(parsed?.ports, '0.0.0.0:5432->5432/tcp');
  // A malformed line is dropped, not thrown on.
  assert.equal(parsePsLine('garbage'), null);
  assert.equal(parsePsLine(''), null);
});

test('listServiceGroups groups by project and flags orphans', async () => {
  const { db, cleanup } = tempDb();
  try {
    // t-live has a thread row; t-orphan does not.
    insertThread(db, 't-live');
    const live = composeProjectName('t-live');
    const orphan = composeProjectName('t-orphan');
    const exec: DockerExec = async () => ({
      ...OK,
      stdout: [
        PS_LINE(live, `${live}-web-1`),
        PS_LINE(live, `${live}-db-1`, 'exited', 'Exited (0) 2 minutes ago', ''),
        PS_LINE(orphan, `${orphan}-web-1`),
        // A non-Nexus project must be ignored entirely.
        PS_LINE('someone-else', 'unrelated-1'),
      ].join('\n'),
    });

    const groups = await listServiceGroups(db, exec);
    assert.equal(groups.length, 2, 'only the two nexus- projects');
    // Orphans sort first.
    assert.equal(groups[0].project, orphan);
    assert.equal(groups[0].orphaned, true);
    assert.equal(groups[1].project, live);
    assert.equal(groups[1].orphaned, false, 'a project with a live thread is not a leak');
    assert.equal(groups[1].containers.length, 2, 'exited containers are listed too');
    assert.ok(groups[1].containers.some((c) => c.state === 'exited'));
  } finally {
    cleanup();
  }
});

test('listServiceGroups returns nothing when docker errors', async () => {
  const { db, cleanup } = tempDb();
  try {
    const exec: DockerExec = async () => ({ stdout: '', stderr: 'daemon down', code: 1 });
    assert.deepEqual(await listServiceGroups(db, exec), []);
  } finally {
    cleanup();
  }
});

// ── routes ────────────────────────────────────────────────────────────────────

async function buildApp(opts: Parameters<typeof registerDockerRoutes>[1]): Promise<FastifyInstance> {
  const { db } = tempDb();
  const app = Fastify();
  app.decorate('db', db as never);
  await app.register(async (f) => { await registerDockerRoutes(f, opts); });
  await app.ready();
  return app;
}

test('GET services reports unavailable without hitting docker', async () => {
  let called = false;
  const app = await buildApp({ isAvailable: () => false, listGroups: async () => { called = true; return []; } });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/docker/services' });
    assert.deepEqual(res.json(), { available: false, groups: [] });
    assert.equal(called, false, 'a docker call is not even attempted when unavailable');
  } finally {
    await app.close();
  }
});

test('GET services returns the grouped list when available', async () => {
  const groups = [{ project: 'nexus-t1', orphaned: true, containers: [] }];
  const app = await buildApp({ isAvailable: () => true, listGroups: async () => groups });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/docker/services' });
    assert.deepEqual(res.json(), { available: true, groups });
  } finally {
    await app.close();
  }
});

test('GET services?thread=X narrows to that thread\'s project', async () => {
  const groups = [
    { project: composeProjectName('thread-a'), orphaned: false, containers: [{ name: 'x', image: 'i', state: 'running', status: 'Up', ports: '' }] },
    { project: composeProjectName('thread-b'), orphaned: true, containers: [] },
  ];
  const app = await buildApp({ isAvailable: () => true, listGroups: async () => groups });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/docker/services?thread=thread-a' });
    const body = res.json() as { groups: Array<{ project: string }> };
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].project, composeProjectName('thread-a'));

    // A thread with no services gets an empty list, not everything.
    const none = await app.inject({ method: 'GET', url: '/api/docker/services?thread=thread-z' });
    assert.deepEqual((none.json() as { groups: unknown[] }).groups, []);
  } finally {
    await app.close();
  }
});

test('POST down tears down a nexus project and refuses anything else', async () => {
  const downs: string[] = [];
  const exec: DockerExec = async (args) => {
    if (args.includes('down')) { downs.push(args[args.indexOf('--project-name') + 1]); return OK; }
    return OK;
  };
  const app = await buildApp({ isAvailable: () => true, exec });
  try {
    const ok = await app.inject({ method: 'POST', url: '/api/docker/services/nexus-t1/down' });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { ok: true, project: 'nexus-t1' });
    assert.deepEqual(downs, ['nexus-t1']);

    // The hard rule: a non-Nexus project can never be torn down through here.
    const refused = await app.inject({ method: 'POST', url: '/api/docker/services/my-postgres/down' });
    assert.equal(refused.statusCode, 400);
    assert.deepEqual(downs, ['nexus-t1'], 'the unrelated stack was never touched');
  } finally {
    await app.close();
  }
});

test('POST down 503s when docker is unavailable, without shelling out', async () => {
  const downs: string[] = [];
  const exec: DockerExec = async (args) => { if (args.includes('down')) downs.push('x'); return OK; };
  const app = await buildApp({ isAvailable: () => false, exec });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/docker/services/nexus-t1/down' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(downs, []);
  } finally {
    await app.close();
  }
});

test('POST down surfaces a compose failure as 502 with its message', async () => {
  const exec: DockerExec = async (args) =>
    args.includes('down') ? { stdout: '', stderr: 'no such network', code: 1 } : OK;
  const app = await buildApp({ isAvailable: () => true, exec });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/docker/services/nexus-t1/down' });
    assert.equal(res.statusCode, 502);
    assert.match((res.json() as { error: string }).error, /no such network/);
  } finally {
    await app.close();
  }
});
