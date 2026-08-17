import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerIdeaRoutes, parseRepoInput, IdeaRouteOptions } from '../routes/ideas';

function appWithDb(options: IdeaRouteOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ideas-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(async (f) => { await registerIdeaRoutes(f, options); });
  return { app, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('capture, list, edit, discard lifecycle', async () => {
  const { app, cleanup } = appWithDb();

  const created = await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Idea one', seed: 'a tangent' } });
  assert.equal(created.statusCode, 200);
  const idea = created.json();
  assert.equal(idea.state, 'parked');
  assert.equal(idea.seed, 'a tangent');
  assert.deepEqual(idea.tags, []);
  assert.equal(idea.source, 'idea_watcher');

  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/ideas/${idea.id}`,
    payload: { tags: ['nexus', 'ui'], target_repo: 'k-sym/nexus' },
  });
  assert.deepEqual(edited.json().tags, ['nexus', 'ui']);
  assert.equal(edited.json().target_repo, 'k-sym/nexus');

  // Discarded is terminal-but-soft: hidden from the default list, kept in ?all=1.
  await app.inject({ method: 'PATCH', url: `/api/ideas/${idea.id}`, payload: { state: 'discarded' } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/ideas' })).json().length, 0);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ideas?all=1' })).json().length, 1);

  await app.close();
  cleanup();
});

test('POST rejects an empty title; PATCH rejects unknown states and bad tags', async () => {
  const { app, cleanup } = appWithDb();
  assert.equal((await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: '  ' } })).statusCode, 400);
  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'x' } })).json().id;
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/ideas/${id}`, payload: { state: 'ripe' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/ideas/${id}`, payload: { tags: 'nope' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/ideas/missing', payload: {} })).statusCode, 404);
  await app.close();
  cleanup();
});

test('session ensure creates one idea-origin assistant session without advancing state', async () => {
  const { app, db, cleanup } = appWithDb();
  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Discuss me' } })).json().id;

  const first = await app.inject({ method: 'POST', url: `/api/ideas/${id}/session` });
  assert.equal(first.statusCode, 200);
  const { sessionId } = first.json();
  assert.ok(sessionId);

  const session = db.prepare('SELECT title, origin FROM assistant_sessions WHERE id = ?').get(sessionId) as any;
  assert.equal(session.origin, 'idea');
  assert.equal(session.title, 'Idea: Discuss me');

  // Opening an idea is not discussing it: no turns yet, so it stays parked.
  let idea = (await app.inject({ method: 'GET', url: '/api/ideas' })).json()[0];
  assert.equal(idea.state, 'parked');
  assert.equal(idea.session_id, sessionId);

  // Idempotent: the same session comes back, no duplicate rows.
  const second = await app.inject({ method: 'POST', url: `/api/ideas/${id}/session` });
  assert.equal(second.json().sessionId, sessionId);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assistant_sessions').get() as any).n, 1);

  // Once the dialogue has a turn, the list pass flips parked → discussing.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assistant_runs (id, session_id, kind, status, input, output, started_at, updated_at)
     VALUES ('r1', ?, 'chat', 'running', 'hello', '', ?, ?)`,
  ).run(sessionId, now, now);
  idea = (await app.inject({ method: 'GET', url: '/api/ideas' })).json()[0];
  assert.equal(idea.state, 'discussing');

  await app.close();
  cleanup();
});

test('a finished research run flips researching → reviewed lazily on list', async () => {
  const { app, db, cleanup } = appWithDb();
  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Research me' } })).json().id;
  const { sessionId } = (await app.inject({ method: 'POST', url: `/api/ideas/${id}/session` })).json();
  await app.inject({ method: 'PATCH', url: `/api/ideas/${id}`, payload: { state: 'researching' } });

  const now = new Date().toISOString();
  const insertRun = db.prepare(
    `INSERT INTO assistant_runs (id, session_id, kind, status, input, output, started_at, updated_at)
     VALUES (?, ?, 'chat', ?, 'brief', '', ?, ?)`,
  );
  insertRun.run('run-1', sessionId, 'running', now, now);
  let listed = (await app.inject({ method: 'GET', url: '/api/ideas' })).json();
  assert.equal(listed[0].state, 'researching', 'stays researching while the run is live');

  db.prepare("UPDATE assistant_runs SET status = 'succeeded' WHERE id = ?").run('run-1');
  listed = (await app.inject({ method: 'GET', url: '/api/ideas' })).json();
  assert.equal(listed[0].state, 'reviewed', 'flips once the run has settled');

  await app.close();
  cleanup();
});

test('graduation files the issue set with cross-links and records the URLs', async () => {
  const calls: { url: string; body: any; auth?: string }[] = [];
  let counter = 100;
  const fetchImpl = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, auth: init.headers.authorization });
    counter += 1;
    return new Response(JSON.stringify({ number: counter, html_url: `https://github.com/k-sym/nexus/issues/${counter}` }), { status: 201 });
  }) as typeof fetch;
  const { app, cleanup } = appWithDb({ fetchImpl, resolveToken: async () => 'tok-1' });

  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Ship it' } })).json().id;
  const res = await app.inject({
    method: 'POST',
    url: `/api/ideas/${id}/graduate/issues`,
    payload: {
      repo: 'k-sym/nexus',
      issues: [
        { title: 'Parent', body: 'The main issue', labels: ['enhancement'] },
        { title: 'Child', body: 'A follow-up' },
      ],
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const payload = res.json();
  assert.equal(payload.issues.length, 2);
  assert.equal(payload.idea.state, 'graduated');
  assert.deepEqual(payload.idea.graduated_to, {
    kind: 'issues',
    urls: ['https://github.com/k-sym/nexus/issues/101', 'https://github.com/k-sym/nexus/issues/102'],
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url === 'https://api.github.com/repos/k-sym/nexus/issues'));
  assert.ok(calls.every((c) => c.auth === 'Bearer tok-1'));
  assert.deepEqual(calls[0].body.labels, ['enhancement']);
  assert.equal(calls[0].body.body, 'The main issue');
  // The second issue of a set carries the back-link to the first.
  assert.equal(calls[1].body.body, 'A follow-up\n\nPart of #101.');

  await app.close();
  cleanup();
});

test('graduation without a token or with a bad repo is rejected before any write', async () => {
  let fetched = 0;
  const fetchImpl = (async () => { fetched += 1; return new Response('{}', { status: 201 }); }) as typeof fetch;
  const { app, cleanup } = appWithDb({ fetchImpl, resolveToken: async () => undefined });
  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'x' } })).json().id;

  const noRepo = await app.inject({ method: 'POST', url: `/api/ideas/${id}/graduate/issues`, payload: { issues: [{ title: 't', body: 'b' }] } });
  assert.equal(noRepo.statusCode, 400);
  const noToken = await app.inject({ method: 'POST', url: `/api/ideas/${id}/graduate/issues`, payload: { repo: 'k-sym/nexus', issues: [{ title: 't', body: 'b' }] } });
  assert.equal(noToken.statusCode, 400);
  // Fastify's default error serializer puts the thrown text in `message`
  // (index.ts's setErrorHandler remaps it to `error` in production).
  assert.match(noToken.json().message, /GitHub token/);
  assert.equal(fetched, 0);

  await app.close();
  cleanup();
});

test('a mid-set GitHub failure still records what was filed', async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    if (n === 1) return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/issues/7' }), { status: 201 });
    return new Response('{"message":"boom"}', { status: 502 });
  }) as typeof fetch;
  const { app, cleanup } = appWithDb({ fetchImpl, resolveToken: async () => 'tok' });
  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'x' } })).json().id;

  const res = await app.inject({
    method: 'POST',
    url: `/api/ideas/${id}/graduate/issues`,
    payload: { repo: 'o/r', issues: [{ title: 'a', body: '1' }, { title: 'b', body: '2' }] },
  });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json().issues, [{ number: 7, html_url: 'https://github.com/o/r/issues/7' }]);

  // Not graduated, but the filed issue is tracked so it can't be lost.
  const idea = (await app.inject({ method: 'GET', url: '/api/ideas' })).json()[0];
  assert.equal(idea.state, 'parked');
  assert.deepEqual(idea.graduated_to, { kind: 'issues', urls: ['https://github.com/o/r/issues/7'] });

  await app.close();
  cleanup();
});

test('graduate/project moves the idea\'s filed attachments into the project repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ideas-grad-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(async (f) => { await registerIdeaRoutes(f, { uploadRoot: dir }); });
  const cleanup = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };

  const now = new Date().toISOString();
  const repoPath = join(dir, 'the-project');
  mkdirSync(repoPath, { recursive: true });
  db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('proj-1', 'proj-1', 'The Project', repoPath, now, now);

  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Grad' } })).json().id;
  // Simulate attachments the assistant routes filed for this idea.
  const ideaUploads = join(dir, 'project_docs', 'uploads', 'ideas', id);
  mkdirSync(ideaUploads, { recursive: true });
  writeFileSync(join(ideaUploads, 'shot.png'), 'png-bytes');

  const res = await app.inject({ method: 'POST', url: `/api/ideas/${id}/graduate/project`, payload: { projectId: 'proj-1' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().movedFiles, 1);
  assert.equal(res.json().idea.state, 'graduated');
  assert.deepEqual(res.json().idea.graduated_to, { kind: 'project', projectId: 'proj-1' });

  const moved = join(repoPath, 'project_docs', 'uploads', 'ideas', id, 'shot.png');
  assert.equal(existsSync(moved), true, 'file moved into the project repo');
  assert.equal(readFileSync(moved, 'utf8'), 'png-bytes');
  assert.equal(existsSync(ideaUploads), false, 'source dir removed after the move');

  await app.close();
  cleanup();
});

test('graduate/project refuses to strand files when the project repo path is unusable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ideas-grad2-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(async (f) => { await registerIdeaRoutes(f, { uploadRoot: dir }); });
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('proj-x', 'proj-x', 'Ghost', join(dir, 'does-not-exist'), now, now);

  const id = (await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Grad' } })).json().id;
  const ideaUploads = join(dir, 'project_docs', 'uploads', 'ideas', id);
  mkdirSync(ideaUploads, { recursive: true });
  writeFileSync(join(ideaUploads, 'keep.txt'), 'x');

  const res = await app.inject({ method: 'POST', url: `/api/ideas/${id}/graduate/project`, payload: { projectId: 'proj-x' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /repo path/);
  // Not graduated, files untouched — the user fixes the project and retries.
  assert.equal(existsSync(join(ideaUploads, 'keep.txt')), true);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ideas' })).json()[0].state, 'parked');

  // With no files to move, a missing repo path is not a blocker.
  rmSync(ideaUploads, { recursive: true, force: true });
  const res2 = await app.inject({ method: 'POST', url: `/api/ideas/${id}/graduate/project`, payload: { projectId: 'proj-x' } });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().movedFiles, 0);

  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('parseRepoInput accepts owner/repo and GitHub URLs', () => {
  assert.deepEqual(parseRepoInput('k-sym/nexus'), { owner: 'k-sym', repo: 'nexus' });
  assert.deepEqual(parseRepoInput('https://github.com/k-sym/nexus.git'), { owner: 'k-sym', repo: 'nexus' });
  assert.deepEqual(parseRepoInput('git@github.com:k-sym/nexus.git'), { owner: 'k-sym', repo: 'nexus' });
  assert.equal(parseRepoInput('not a repo'), null);
  assert.equal(parseRepoInput(''), null);
});
