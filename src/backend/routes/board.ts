/**
 * Session-first board (#439). The board is a projection computed on every
 * read: a project's threads (live, plus Done for 30 days) become cards with a
 * derived lane and an origin; the project's open GitHub issues and active
 * Monday items that have no card become the Inbox. Nothing is stored per lane.
 *
 * Two more routes start a session from an Inbox item the way Tickets does from
 * Jira (#432): draft the real problem with the configured Claude model, then Go.
 * Neither writes to GitHub or Monday; the only external read is the issue list.
 */
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  BoardCard, BoardInboxItem, BoardOrigin, BoardResponse, ChatThread, MondayItem, MondayProjectConfig,
  OriginDraft, OriginSessionRequest, OriginSessionResult, Project,
} from '@nexus/shared';
import { loadConfig } from '../config.js';
import { deriveLane, doneWindowStart } from '../board/lanes.js';
import { draftOrigin, buildOriginFirstTurn, originLabel, type OriginDraftInput } from '../board/draft.js';
import { listOpenIssues, ensureProjectGitRemote, noteSyncError, clearSyncError, type InboxIssuesResult } from '../github/inbox.js';
import { isRunning } from '../chat/run-registry.js';
import { getItem, listItemsForBoard, listLinksForProject, linkThread } from '../monday/store.js';
import { onThreadLinked } from '../monday/thread-hooks.js';
import { insertNotification } from '../notifications/index.js';
import { runClaudeOneShot } from '../engines/claude/one-shot.js';
import { CLAUDE_CODE_PROVIDER, findClaudeModel } from '../engines/claude/models.js';
import type { DraftProject } from '../tickets/draft.js';
import type { ActivityEvent } from '../activity/events.js';

const NEW_THREAD_TITLE = 'New Session';

export interface BoardRouteOptions {
  /** Test seam: replaces the Claude one-shot call. */
  generate?: (systemPrompt: string, prompt: string) => Promise<string>;
  /** Test seam: replaces the GitHub read. */
  listIssues?: (project: Project, refresh: boolean) => Promise<InboxIssuesResult>;
  now?: () => Date;
}

function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

function projectMondayConfig(project: Project | undefined): MondayProjectConfig | null {
  if (!project) return null;
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

/** Status line plus the item's text columns, so the draft has something to read. */
function mondayItemBody(item: MondayItem): string {
  const lines: string[] = [];
  if (item.status_label) lines.push(`Status: ${item.status_label}`);
  if (item.group_title) lines.push(`Group: ${item.group_title}`);
  try {
    const owners = JSON.parse(item.owners_json || '[]') as string[];
    if (owners.length) lines.push(`Owners: ${owners.join(', ')}`);
  } catch { /* owners are optional context */ }
  try {
    const cols = JSON.parse(item.column_values_json || '{}') as Record<string, { text?: string | null; title?: string | null }>;
    for (const col of Object.values(cols)) {
      const text = (col?.text ?? '').toString().trim();
      if (text) lines.push(`${col.title ?? 'Column'}: ${text}`);
    }
  } catch { /* columns are optional context */ }
  return lines.join('\n');
}

export async function registerBoardRoutes(fastify: FastifyInstance, opts: BoardRouteOptions = {}) {
  const db: Database.Database = fastify.db;
  const now = opts.now ?? (() => new Date());
  const emit = (event: ActivityEvent) => fastify.activity?.bus.emit(event);
  const pi = (fastify as unknown as {
    pi?: {
      questions?: { pendingCount(threadId: string): number };
      approvals?: { listPending(): Array<{ threadId: string }> };
    };
  }).pi;

  const listIssues = opts.listIssues ?? (async (project: Project, refresh: boolean) => {
    const withRemote = await ensureProjectGitRemote(db, project);
    return listOpenIssues(withRemote, { refresh, emit });
  });

  const projectRow = (id: string): Project | undefined =>
    db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;

  const ticketUrl = (key: string): string | null =>
    (db.prepare('SELECT url FROM tickets WHERE key = ?').get(key) as { url: string | null } | undefined)?.url ?? null;

  /** Threads that count as "on the board": live, or Done within the window. */
  const boardThreads = (projectId: string): ChatThread[] =>
    db.prepare(
      'SELECT * FROM chat_threads WHERE project_id = ? AND (archived_at IS NULL OR archived_at >= ?) ORDER BY updated_at DESC',
    ).all(projectId, doneWindowStart(now())) as ChatThread[];

  const pendingApprovalsByThread = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const approval of pi?.approvals?.listPending() ?? []) {
      counts.set(approval.threadId, (counts.get(approval.threadId) ?? 0) + 1);
    }
    return counts;
  };

  fastify.get('/api/projects/:id/board', async (request): Promise<BoardResponse> => {
    const { id } = request.params as { id: string };
    const refresh = (request.query as { refresh?: string }).refresh != null;
    const project = projectRow(id);
    if (!project) throw httpError(404, 'Project not found');

    const config = loadConfig();
    const threads = boardThreads(id);
    const links = new Map(listLinksForProject(db, id).map((l) => [l.thread_id, l.item_id]));
    const approvals = pendingApprovalsByThread();

    // GitHub feed first: the origin URL of a github card comes from the repo.
    let github: InboxIssuesResult = { ref: null, issues: [], fromCache: false, error: null };
    const inboxErrors: BoardResponse['inbox_errors'] = {};
    if (config.github.enabled) {
      github = await listIssues(project, refresh);
      if (github.error) {
        inboxErrors.github = github.error;
        // Same dedupe the old sync had: one toast per distinct failure.
        if (noteSyncError(id, github.error)) {
          insertNotification(db, { level: 'error', title: 'GitHub issues unavailable', message: `${project.name}: ${github.error}` });
        }
      } else if (github.ref) {
        clearSyncError(id);
      }
    }
    const issueUrl = (n: number): string => github.ref
      ? `https://github.com/${github.ref.owner}/${github.ref.repo}/issues/${n}`
      : `#${n}`;

    const cards: BoardCard[] = threads.map((thread) => {
      const running = isRunning(thread.id);
      const pendingQuestions = running ? (pi?.questions?.pendingCount(thread.id) ?? 0) : 0;
      const pendingApprovals = running ? (approvals.get(thread.id) ?? 0) : 0;
      const mondayItemId = links.get(thread.id) ?? null;
      let origin: BoardOrigin = { kind: 'chat' };
      if (thread.ticket_key) origin = { kind: 'ticket', key: thread.ticket_key, url: ticketUrl(thread.ticket_key) };
      else if (thread.github_issue != null) origin = { kind: 'github', number: thread.github_issue, url: issueUrl(thread.github_issue) };
      else if (mondayItemId) {
        const item = getItem(db, mondayItemId);
        origin = { kind: 'monday', item_id: mondayItemId, name: item?.name ?? mondayItemId, url: item?.url ?? null };
      }
      return {
        thread,
        lane: deriveLane({ archived_at: thread.archived_at, running, pending_questions: pendingQuestions, pending_approvals: pendingApprovals }),
        origin,
        running,
        pending_questions: pendingQuestions,
        pending_approvals: pendingApprovals,
        monday_item_id: mondayItemId,
      };
    });

    // Inbox: what is open upstream and not yet on the board (D4).
    const onBoardIssues = new Set(threads.map((t) => t.github_issue).filter((n): n is number => n != null));
    const onBoardItems = new Set(threads.map((t) => links.get(t.id)).filter((x): x is string => !!x));
    const inbox: BoardInboxItem[] = [];
    for (const issue of github.issues) {
      if (onBoardIssues.has(issue.number)) continue;
      inbox.push({ kind: 'github', id: String(issue.number), title: issue.title, url: issue.html_url, labels: issue.labels, status_label: null, updated: null });
    }
    const mondayCfg = projectMondayConfig(project);
    if (mondayCfg) {
      try {
        for (const item of listItemsForBoard(db, mondayCfg.board_id, mondayCfg.group_id ?? null)) {
          if (item.state !== 'active' || onBoardItems.has(item.item_id)) continue;
          inbox.push({ kind: 'monday', id: item.item_id, title: item.name, url: item.url, labels: [], status_label: item.status_label, updated: item.monday_updated_at ?? null });
        }
      } catch (err) {
        inboxErrors.monday = (err as Error)?.message ?? 'Monday mirror unavailable';
      }
    }

    return { cards, inbox, inbox_errors: inboxErrors };
  });

  /** Resolve an Inbox reference to draft input, or null when it is not in the feed. */
  const resolveOrigin = async (project: Project, kind: string, id: string): Promise<OriginDraftInput | null> => {
    if (kind === 'github') {
      const number = Number(id);
      if (!Number.isInteger(number) || number <= 0) return null;
      const result = await listIssues(project, false);
      const issue = result.issues.find((i) => i.number === number);
      if (!issue) return null;
      return { kind, id: String(number), title: issue.title, url: issue.html_url, body: issue.body ?? '' };
    }
    if (kind === 'monday') {
      const item = getItem(db, id);
      if (!item) return null;
      return { kind, id: item.item_id, title: item.name, url: item.url, body: mondayItemBody(item) };
    }
    return null;
  };

  fastify.post('/api/projects/:id/board/draft', async (request, reply): Promise<OriginDraft | { error: string }> => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { kind?: string; id?: string };
    const project = projectRow(id);
    if (!project) throw httpError(404, 'Project not found');
    const input = await resolveOrigin(project, body.kind ?? '', body.id ?? '');
    if (!input) throw httpError(404, 'Origin not found in this project\'s Inbox');

    const config = loadConfig();
    const modelKey = (config.jira.draft_model || '').trim();
    const sep = modelKey.indexOf('/');
    const provider = sep > 0 ? modelKey.slice(0, sep) : '';
    const modelId = sep > 0 ? modelKey.slice(sep + 1) : '';
    if (provider !== CLAUDE_CODE_PROVIDER || !modelId) {
      reply.status(400);
      return { error: `jira.draft_model must be a claude-code/* model key (got "${modelKey || 'empty'}")` };
    }
    if (!opts.generate && !findClaudeModel(modelId)) {
      reply.status(400);
      return { error: `jira.draft_model names an unknown Claude model "${modelId}"` };
    }
    if (!opts.generate && !config.engines.claude.enabled) {
      reply.status(400);
      return { error: 'The Claude engine is disabled in Settings; drafting needs it' };
    }

    const projects = db.prepare('SELECT id, name, description FROM projects ORDER BY sort_order ASC, name COLLATE NOCASE ASC').all() as DraftProject[];
    const generate = opts.generate
      ?? ((systemPrompt: string, prompt: string) => runClaudeOneShot(config.engines.claude, { modelId, systemPrompt, prompt }));

    const operationId = randomUUID();
    const started = Date.now();
    const title = `Draft ${input.kind === 'github' ? `#${input.id}` : input.title}`;
    emit({ type: 'start', operationId, kind: 'ticket_draft', title, projectId: id, provider, model: modelId });
    try {
      const draft = await draftOrigin(input, projects, { generate, model: modelKey });
      if (!draft) {
        emit({ type: 'stop', operationId, kind: 'ticket_draft', title, status: 'failed', durationMs: Date.now() - started, error: 'Model returned nothing usable' });
        reply.status(502);
        return { error: 'The model returned nothing usable; try again' };
      }
      // The board's project is the natural default when the model has no opinion.
      if (!draft.projectId) draft.projectId = id;
      emit({ type: 'stop', operationId, kind: 'ticket_draft', title, status: 'succeeded', durationMs: Date.now() - started, projectId: draft.projectId, diagnostics: { branchName: draft.branchName } });
      return draft;
    } catch (err) {
      const message = (err as Error).message;
      emit({ type: 'stop', operationId, kind: 'ticket_draft', title, status: 'failed', durationMs: Date.now() - started, error: message });
      reply.status(502);
      return { error: message };
    }
  });

  fastify.post('/api/projects/:id/board/session', async (request): Promise<OriginSessionResult> => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<OriginSessionRequest>;
    const boardProject = projectRow(id);
    if (!boardProject) throw httpError(404, 'Project not found');
    const problem = typeof body.problem === 'string' ? body.problem.trim() : '';
    const branchName = typeof body.branchName === 'string' ? body.branchName.trim() : '';
    if (!problem) throw httpError(400, 'problem is required');
    if (!branchName) throw httpError(400, 'branchName is required');
    const targetId = typeof body.projectId === 'string' && body.projectId ? body.projectId : id;
    const target = projectRow(targetId);
    if (!target) throw httpError(404, 'Project not found');
    const input = await resolveOrigin(boardProject, body.kind ?? '', body.id ?? '');
    if (!input) throw httpError(404, 'Origin not found in this project\'s Inbox');

    const nowIso = now().toISOString();
    const title = (input.kind === 'github' ? `#${input.id} ${input.title}` : input.title).trim().slice(0, 120) || NEW_THREAD_TITLE;
    const thread: ChatThread = {
      id: randomUUID(),
      project_id: targetId,
      title,
      created_at: nowIso,
      updated_at: nowIso,
      archived_at: null,
      github_issue: input.kind === 'github' ? Number(input.id) : null,
    };
    db.prepare(
      'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at, github_issue) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(thread.id, thread.project_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at, thread.github_issue);

    if (input.kind === 'monday') {
      // The Monday origin IS the link: the roll-up and status sync now follow
      // this session, and the first sync may advance the item off its inbox
      // label (the same ownership handoff the link route performs).
      linkThread(db, { thread_id: thread.id, item_id: input.id, project_id: targetId, created_at: nowIso });
      onThreadLinked(db, thread.id, emit);
    }

    return {
      thread,
      firstTurn: buildOriginFirstTurn({ kind: input.kind, id: input.id, title: input.title, url: input.url, problem, branchName }),
    };
  });
}

export { originLabel };
