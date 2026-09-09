import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MondayItem, Project } from '@nexus/shared';
import { getDb } from '../db';
import { registerBoardRoutes, type BoardRouteOptions } from '../routes/board';
import { markRunning, __resetRunRegistry } from '../chat/run-registry';
import { upsertItems } from '../monday/store';
import type { InboxIssuesResult } from '../github/inbox';

delete process.env.JIRA_TOKEN;
delete process.env.MONDAY_TOKEN;

const NOW = new Date('2026-09-09T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function issues(list: Array<{ number: number; title: string; body?: string; labels?: string[] }>, error: string | null = null): InboxIssuesResult {
  return {
    ref: { owner: 'k-sym', repo: 'nexus' },
    issues: list.map((i) => ({ number: i.number, title: i.title, body: i.body ?? null, html_url: `https://github.com/k-sym/nexus/issues/${i.number}`, labels: i.labels ?? [] })),
    fromCache: false,
    error,
  };
}

function mondayItem(id: string, over: Partial<MondayItem> = {}): MondayItem {
  return {
    item_id: id, board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: 'Q3',
    name: `Item ${id}`, state: 'active', status_label: 'Planned', status_color: null,
    owners_json: '["Keith"]', url: `https://x.monday.com/boards/b1/pulses/${id}`,
    column_values_json: JSON.stringify({ text_1: { title: 'Notes', text: 'Refresh the portfolio page' } }),
    monday_updated_at: '2026-09-01T00:00:00.000Z', synced_at: NOW.toISOString(), ...over,
  } as MondayItem;
}

interface Harness {
  app: ReturnType<typeof Fastify>;
  db: ReturnType<typeof getDb>;
  events: any[];
  cleanup: () => void;
}

function harness(routeOpts: Partial<BoardRouteOptions> = {}, extra: { pendingQuestions?: Record<string, number>; pendingApprovals?: string[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-board-routes-'));
  const db = getDb(join(dir, 'test.db'));
  const events: any[] = [];
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('activity', { bus: { emit: (e: unknown) => events.push(e) } });
  app.decorate('pi', {
    questions: { pendingCount: (id: string) => extra.pendingQuestions?.[id] ?? 0 },
    approvals: { listPending: () => (extra.pendingApprovals ?? []).map((threadId) => ({ threadId })) },
  });
  app.register(registerBoardRoutes, { now: () => NOW, listIssues: async () => issues([]), ...routeOpts });
  const ts = NOW.toISOString();
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','nexus','Nexus','N','Agent OS','/tmp/nexus', ?, 0, 'git@github.com:k-sym/nexus.git', ?, ?)`)
    .run(JSON.stringify({ monday: { board_id: 'b1', group_id: null, rollup: { enabled: false, column_id: null } } }), ts, ts);
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p2','wse','WSE','W','PHP API','/tmp/wse','{}', 1, '', ?, ?)`).run(ts, ts);
  return { app, db, events, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const thread = (db: Harness['db'], id: string, over: Partial<{ title: string; archived_at: string | null; ticket_key: string | null; github_issue: number | null; updated_at: string }> = {}) => {
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at, ticket_key, github_issue) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'p1', over.title ?? `Thread ${id}`, daysAgo(2), over.updated_at ?? daysAgo(1), over.archived_at ?? null, over.ticket_key ?? null, over.github_issue ?? null);
};

beforeEach(() => __resetRunRegistry());

test('GET board: lanes derived from state, origins resolved, Inbox deduped against cards on the board', async () => {
  const h = harness(
    { listIssues: async () => issues([{ number: 1, title: 'Open one' }, { number: 2, title: 'Has a session' }, { number: 3, title: 'Done long ago' }]) },
    { pendingQuestions: { 'th-waiting': 1 } },
  );
  const { app, db } = h;
  upsertItems(db, [mondayItem('m1'), mondayItem('m2'), mondayItem('m3', { state: 'archived' })]);
  db.prepare("INSERT INTO tickets (key, summary, url, synced_at) VALUES ('SUP-9', 'Ticket', 'https://x.atlassian.net/browse/SUP-9', ?)").run(NOW.toISOString());
  thread(db, 'th-running', { github_issue: 2, title: '#2 Has a session' });
  thread(db, 'th-waiting');
  thread(db, 'th-idle', { ticket_key: 'SUP-9' });
  thread(db, 'th-done', { archived_at: daysAgo(3) });
  thread(db, 'th-old-done', { archived_at: daysAgo(40), github_issue: 3 });
  db.prepare("INSERT INTO thread_monday_links (thread_id, item_id, project_id, created_at) VALUES ('th-idle', 'm1', 'p1', ?)").run(NOW.toISOString());
  markRunning('th-running', { title: 'x', modelKey: 'm' });
  markRunning('th-waiting', { title: 'x', modelKey: 'm' });

  const res = await app.inject({ method: 'GET', url: '/api/projects/p1/board' });
  assert.equal(res.statusCode, 200, res.body);
  const board = res.json();
  const byId = Object.fromEntries(board.cards.map((c: any) => [c.thread.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['th-done', 'th-idle', 'th-running', 'th-waiting'], 'the 40-day-old archive is off the board');
  assert.equal(byId['th-running'].lane, 'running');
  assert.deepEqual(byId['th-running'].origin, { kind: 'github', number: 2, url: 'https://github.com/k-sym/nexus/issues/2' });
  assert.equal(byId['th-waiting'].lane, 'needs_you');
  assert.equal(byId['th-waiting'].pending_questions, 1);
  assert.deepEqual(byId['th-waiting'].origin, { kind: 'chat' });
  assert.equal(byId['th-idle'].lane, 'idle');
  // Ticket origin wins over the Monday link, which still shows as the linked item.
  assert.deepEqual(byId['th-idle'].origin, { kind: 'ticket', key: 'SUP-9', url: 'https://x.atlassian.net/browse/SUP-9' });
  assert.equal(byId['th-idle'].monday_item_id, 'm1');
  assert.equal(byId['th-done'].lane, 'done');

  // Inbox: #2 has a card; #3's card fell off the board so it is back; m1 is linked; m3 is archived upstream.
  assert.deepEqual(board.inbox.map((i: any) => [i.kind, i.id]), [['github', '1'], ['github', '3'], ['monday', 'm2']]);
  assert.equal(board.inbox[2].status_label, 'Planned');
  assert.deepEqual(board.inbox_errors, {});
  await app.close(); h.cleanup();
});

test('GET board: a failed GitHub feed lands in inbox_errors with the cards intact, and notifies once', async () => {
  const h = harness({ listIssues: async () => issues([], 'GitHub k-sym/nexus -> HTTP 404') });
  thread(h.db, 'th-1');
  for (let i = 0; i < 2; i++) {
    const res = await h.app.inject({ method: 'GET', url: '/api/projects/p1/board' });
    assert.equal(res.statusCode, 200);
    const board = res.json();
    assert.equal(board.cards.length, 1);
    assert.deepEqual(board.inbox, []);
    assert.equal(board.inbox_errors.github, 'GitHub k-sym/nexus -> HTTP 404');
  }
  assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as any).n, 1);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/projects/nope/board' })).statusCode, 404);
  await h.app.close(); h.cleanup();
});

test('GET board: an approval pending on a running thread is Needs you; a stale gate on an idle thread is not', async () => {
  const h = harness({}, { pendingApprovals: ['th-run', 'th-idle'] });
  thread(h.db, 'th-run');
  thread(h.db, 'th-idle');
  markRunning('th-run', { title: 'x', modelKey: 'm' });
  const board = (await h.app.inject({ method: 'GET', url: '/api/projects/p1/board' })).json();
  const byId = Object.fromEntries(board.cards.map((c: any) => [c.thread.id, c]));
  assert.equal(byId['th-run'].lane, 'needs_you');
  assert.equal(byId['th-run'].pending_approvals, 1);
  assert.equal(byId['th-idle'].lane, 'idle');
  assert.equal(byId['th-idle'].pending_approvals, 0);
  await h.app.close(); h.cleanup();
});

test('POST draft: GitHub issue → OriginDraft via the injected generator; unknown origin 404s; unusable reply 502s', async () => {
  let prompt = '';
  const h = harness({
    listIssues: async () => issues([{ number: 439, title: 'Session-first Kanban', body: 'The board is stale.' }]),
    generate: async (_s, p) => { prompt = p; return '{"problem":"Replace tasks with sessions.","project":"Nexus","branchType":"feature","branchDescription":"session first board"}'; },
  });
  const res = await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/draft', payload: { kind: 'github', id: '439' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    origin: { kind: 'github', id: '439' }, problem: 'Replace tasks with sessions.', projectId: 'p1',
    branchType: 'feat', branchName: 'feat/session-first-board', model: 'claude-code/claude-sonnet-5',
  });
  assert.match(prompt, /GitHub issue #439: Session-first Kanban/);
  assert.match(prompt, /The board is stale\./);
  assert.deepEqual(h.events.map((e) => [e.type, e.kind, e.title, e.status]), [['start', 'ticket_draft', 'Draft #439', undefined], ['stop', 'ticket_draft', 'Draft #439', 'succeeded']]);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/draft', payload: { kind: 'github', id: '7' } })).statusCode, 404);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/draft', payload: { kind: 'jira', id: 'x' } })).statusCode, 404);
  await h.app.close(); h.cleanup();

  const bad = harness({ listIssues: async () => issues([{ number: 1, title: 'One' }]), generate: async () => 'no' });
  const r = await bad.app.inject({ method: 'POST', url: '/api/projects/p1/board/draft', payload: { kind: 'github', id: '1' } });
  assert.equal(r.statusCode, 502);
  await bad.app.close(); bad.cleanup();
});

test('POST draft: Monday item body carries status, owners and column text; model default is the board project when unsure', async () => {
  let prompt = '';
  const h = harness({ generate: async (_s, p) => { prompt = p; return '{"problem":"Refresh it.","project":null,"branchType":"feat","branchDescription":"portfolio refresh"}'; } });
  upsertItems(h.db, [mondayItem('m1', { name: 'Portfolio refresh' })]);
  const res = await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/draft', payload: { kind: 'monday', id: 'm1' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().projectId, 'p1');
  assert.equal(res.json().branchName, 'feat/portfolio-refresh');
  assert.match(prompt, /Monday item "Portfolio refresh": Portfolio refresh/);
  assert.match(prompt, /Status: Planned\nGroup: Q3\nOwners: Keith\nNotes: Refresh the portfolio page/);
  await h.app.close(); h.cleanup();
});

test('POST session: GitHub issue → thread stamped with the number, titled from the issue, first turn composed', async () => {
  const h = harness({ listIssues: async () => issues([{ number: 439, title: 'Session-first Kanban' }]) });
  const res = await h.app.inject({
    method: 'POST', url: '/api/projects/p1/board/session',
    payload: { kind: 'github', id: '439', problem: 'Replace tasks with sessions.', branchName: 'feat/session-first-kanban' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { thread: t, firstTurn } = res.json();
  assert.equal(t.project_id, 'p1');
  assert.equal(t.github_issue, 439);
  assert.equal(t.title, '#439 Session-first Kanban');
  assert.ok(firstTurn.startsWith('Replace tasks with sessions.\n\nSource: GitHub issue #439 (https://github.com/k-sym/nexus/issues/439) — "Session-first Kanban".'));
  assert.match(firstTurn, /`feat\/session-first-kanban`/);
  assert.match(firstTurn, /commit and push/);
  assert.match(firstTurn, /do not open a PR or merge/);
  assert.match(firstTurn, /Do not close, comment on or edit the issue/);
  const row = h.db.prepare('SELECT github_issue, project_id FROM chat_threads WHERE id = ?').get(t.id) as any;
  assert.deepEqual(row, { github_issue: 439, project_id: 'p1' });

  // The issue has left the Inbox and its card is on the board.
  const board = (await h.app.inject({ method: 'GET', url: '/api/projects/p1/board' })).json();
  assert.deepEqual(board.inbox, []);
  assert.deepEqual(board.cards[0].origin, { kind: 'github', number: 439, url: 'https://github.com/k-sym/nexus/issues/439' });
  assert.equal(board.cards[0].lane, 'idle');
  await h.app.close(); h.cleanup();
});

test('POST session: Monday item → thread in the chosen project with a link row; validation errors', async () => {
  const h = harness();
  upsertItems(h.db, [mondayItem('m1', { name: 'Portfolio refresh' })]);
  const res = await h.app.inject({
    method: 'POST', url: '/api/projects/p1/board/session',
    payload: { kind: 'monday', id: 'm1', projectId: 'p2', problem: 'Refresh it.', branchName: 'feat/portfolio' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const { thread: t, firstTurn } = res.json();
  assert.equal(t.project_id, 'p2');
  assert.equal(t.title, 'Portfolio refresh');
  assert.equal(t.github_issue, null);
  assert.match(firstTurn, /Source: Monday item "Portfolio refresh" \(https:\/\/x\.monday\.com\/boards\/b1\/pulses\/m1\)\./);
  assert.match(firstTurn, /Do not write to Monday/);
  const link = h.db.prepare('SELECT item_id, project_id FROM thread_monday_links WHERE thread_id = ?').get(t.id) as any;
  assert.deepEqual(link, { item_id: 'm1', project_id: 'p2' });

  const missing = await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/session', payload: { kind: 'monday', id: 'm1', problem: '', branchName: 'x' } });
  assert.equal(missing.statusCode, 400);
  const noBranch = await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/session', payload: { kind: 'monday', id: 'm1', problem: 'x', branchName: '' } });
  assert.equal(noBranch.statusCode, 400);
  const badProject = await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/session', payload: { kind: 'monday', id: 'm1', projectId: 'nope', problem: 'x', branchName: 'y' } });
  assert.equal(badProject.statusCode, 404);
  const gone = await h.app.inject({ method: 'POST', url: '/api/projects/p1/board/session', payload: { kind: 'monday', id: 'm9', problem: 'x', branchName: 'y' } });
  assert.equal(gone.statusCode, 404);
  await h.app.close(); h.cleanup();
});
