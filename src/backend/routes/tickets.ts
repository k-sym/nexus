/**
 * Tickets — a disposable mirror of Jira tickets assigned to the user.
 *
 * `POST /api/jira/sync` is the push path (the legacy OpenClaw "Nigel" cron). The
 * native poll (jira/poll.ts) shares the same syncTickets() upsert. Jira stays
 * canonical; Nexus never writes back.
 *
 * Ticket to session (#432): `POST /api/tickets/:key/draft` distils the real
 * problem with a one-shot Claude SDK call; `POST /api/tickets/:key/session`
 * opens a thread stamped with the ticket key and returns the exact first turn
 * for the client to send.
 */
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ChatThread, TicketDraft, TicketSessionRequest, TicketSessionResult } from '@nexus/shared';
import { syncTickets, type IncomingTicket } from '../tickets/sync.js';
import { cleanAdf, type AdfNode } from '../tickets/cleanAdf.js';
import { fetchJiraIssueDescription } from '../jira/client.js';
import { loadConfig } from '../config.js';
import { buildFirstTurn, draftTicketRaw, DRAFT_SYSTEM_PROMPT, type DraftProject } from '../tickets/draft.js';
import { runClaudeOneShot } from '../engines/claude/one-shot.js';
import { CLAUDE_CODE_PROVIDER, findClaudeModel } from '../engines/claude/models.js';
import type { ActivityEvent } from '../activity/events.js';

const NEW_THREAD_TITLE = 'New Session';
/** Raw model text kept when a draft parses to nothing (#432): stderr gets ~2 KB, the operations ledger a short snippet. */
const RAW_LOG_LIMIT = 2048;
const RAW_SNIPPET_LIMIT = 300;

export interface TicketRouteOptions {
  /** Test seam: replaces the Claude one-shot call behind the draft route. */
  generate?: (systemPrompt: string, prompt: string) => Promise<string>;
}

interface TicketRow {
  key: string;
  summary: string;
  url: string | null;
  description_adf: string | null;
  description_fetched_at: string | null;
}

interface DescriptionResult {
  key: string;
  body: string;
  trimmed: { kind: 'forwarded' | 'footer'; text: string }[];
  fetchedAt: string | null;
  empty: boolean;
  error?: string;
}

/** Cleaned description from cache, or from Jira when `refresh` or nothing is
 *  cached and Jira is configured. `error` set (and cache returned) when the
 *  live fetch failed. */
async function loadDescription(db: FastifyInstance['db'], row: TicketRow, refresh: boolean): Promise<DescriptionResult> {
  const config = loadConfig();
  const rules = config.jira.content_rules ?? [];
  const key = row.key;

  const respond = (adfJson: string | null, fetchedAt: string | null): DescriptionResult => {
    if (!adfJson) return { key, body: '', trimmed: [], fetchedAt, empty: true };
    let adf: AdfNode | null = null;
    try { adf = JSON.parse(adfJson) as AdfNode; } catch { adf = null; }
    const cleaned = cleanAdf(adf, rules);
    return { key, body: cleaned.body, trimmed: cleaned.trimmed, fetchedAt, empty: cleaned.body.length === 0 };
  };

  if (row.description_adf && !refresh) return respond(row.description_adf, row.description_fetched_at);

  const token = process.env.JIRA_TOKEN;
  if (!config.jira.enabled || !config.jira.user || !config.jira.instance || !token) {
    return respond(row.description_adf, row.description_fetched_at);
  }

  try {
    const adf = await fetchJiraIssueDescription(
      { user: config.jira.user, instance: config.jira.instance, project: config.jira.project },
      token,
      key,
    );
    const adfJson = adf ? JSON.stringify(adf) : null;
    const fetchedAt = new Date().toISOString();
    db.prepare('UPDATE tickets SET description_adf = ?, description_fetched_at = ? WHERE key = ?').run(adfJson, fetchedAt, key);
    return respond(adfJson, fetchedAt);
  } catch (err) {
    return { ...respond(row.description_adf, row.description_fetched_at), error: (err as Error).message };
  }
}

function httpError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export async function registerTicketRoutes(fastify: FastifyInstance, opts: TicketRouteOptions = {}) {
  const db = fastify.db;
  const activity = (fastify as unknown as { activity?: { bus: { emit: (e: ActivityEvent) => void } } }).activity;
  const emit = (event: ActivityEvent) => activity?.bus.emit(event);

  const ticketRow = (key: string): TicketRow | undefined =>
    db.prepare('SELECT key, summary, url, description_adf, description_fetched_at FROM tickets WHERE key = ?').get(key) as TicketRow | undefined;

  fastify.get('/api/tickets', async () => {
    // Latest open thread per ticket key; the poll may have dropped the ticket
    // row by the time the thread is looked at, so the join is left-sided.
    return db.prepare(`
      SELECT t.*, s.thread_id AS session_thread_id, s.project_id AS session_project_id
      FROM tickets t
      LEFT JOIN (
        SELECT ticket_key, id AS thread_id, project_id,
               ROW_NUMBER() OVER (PARTITION BY ticket_key ORDER BY updated_at DESC) AS rn
        FROM chat_threads WHERE ticket_key IS NOT NULL AND archived_at IS NULL
      ) s ON s.ticket_key = t.key AND s.rn = 1
      ORDER BY datetime(t.updated) DESC, t.key DESC
    `).all().map((row) => {
      const { session_thread_id, session_project_id, ...ticket } = row as Record<string, unknown> & { session_thread_id: string | null; session_project_id: string | null };
      return {
        ...ticket,
        session: session_thread_id && session_project_id ? { thread_id: session_thread_id, project_id: session_project_id } : null,
      };
    });
  });

  fastify.get('/api/tickets/:key/description', async (request, reply) => {
    const { key } = request.params as { key: string };
    const refresh = (request.query as { refresh?: string }).refresh != null;
    const row = ticketRow(key);
    if (!row) throw httpError(404, 'Ticket not found');
    const result = await loadDescription(db, row, refresh);
    if (result.error) reply.status(502);
    return result;
  });

  fastify.post('/api/tickets/:key/draft', async (request, reply): Promise<TicketDraft | { error: string }> => {
    const { key } = request.params as { key: string };
    const row = ticketRow(key);
    if (!row) throw httpError(404, 'Ticket not found');

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

    const description = await loadDescription(db, row, true);
    const projects = db.prepare('SELECT id, name, description FROM projects ORDER BY sort_order ASC, name COLLATE NOCASE ASC').all() as DraftProject[];
    const generate = opts.generate
      ?? ((systemPrompt: string, prompt: string) => runClaudeOneShot(config.engines.claude, { modelId, systemPrompt, prompt }));

    const operationId = randomUUID();
    const started = Date.now();
    emit({ type: 'start', operationId, kind: 'ticket_draft', title: `Draft ${key}`, provider, model: modelId });
    try {
      const { draft, text } = await draftTicketRaw(
        { key: row.key, summary: row.summary, url: row.url, body: description.body },
        projects,
        { generate, model: modelKey },
      );
      if (!draft) {
        // #432: the raw reply is the only way to tell a refusal from a parse
        // slip (e.g. a trailing comma), so keep it in the log and the ledger.
        const raw = typeof text === 'string' ? text : String(text ?? '');
        console.error(`[ticket-draft] ${key} (${modelKey}) unusable reply, ${raw.length} chars:\n${raw.slice(0, RAW_LOG_LIMIT)}${raw.length > RAW_LOG_LIMIT ? '\n…[truncated]' : ''}`);
        emit({
          type: 'stop', operationId, kind: 'ticket_draft', title: `Draft ${key}`, status: 'failed', durationMs: Date.now() - started,
          error: 'Model returned nothing usable',
          diagnostics: { rawLength: raw.length, rawSnippet: raw.slice(0, RAW_SNIPPET_LIMIT) },
        });
        reply.status(502);
        return { error: 'The model returned nothing usable; try again' };
      }
      emit({ type: 'stop', operationId, kind: 'ticket_draft', title: `Draft ${key}`, status: 'succeeded', durationMs: Date.now() - started, projectId: draft.projectId, diagnostics: { branchName: draft.branchName } });
      return draft;
    } catch (err) {
      const message = (err as Error).message;
      emit({ type: 'stop', operationId, kind: 'ticket_draft', title: `Draft ${key}`, status: 'failed', durationMs: Date.now() - started, error: message });
      reply.status(502);
      return { error: message };
    }
  });

  fastify.post('/api/tickets/:key/session', async (request): Promise<TicketSessionResult> => {
    const { key } = request.params as { key: string };
    const body = (request.body ?? {}) as Partial<TicketSessionRequest>;
    const row = ticketRow(key);
    if (!row) throw httpError(404, 'Ticket not found');
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const problem = typeof body.problem === 'string' ? body.problem.trim() : '';
    const branchName = typeof body.branchName === 'string' ? body.branchName.trim() : '';
    if (!problem) throw httpError(400, 'problem is required');
    if (!branchName) throw httpError(400, 'branchName is required');
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
    if (!project) throw httpError(404, 'Project not found');

    const now = new Date().toISOString();
    const title = `${row.key} ${row.summary}`.trim().slice(0, 120) || NEW_THREAD_TITLE;
    const thread: ChatThread = {
      id: randomUUID(),
      project_id: projectId,
      title,
      created_at: now,
      updated_at: now,
      archived_at: null,
      ticket_key: row.key,
    };
    db.prepare(
      'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at, ticket_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(thread.id, thread.project_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at, thread.ticket_key);

    return {
      thread,
      firstTurn: buildFirstTurn({ key: row.key, url: row.url, summary: row.summary, problem, branchName }),
    };
  });

  fastify.post('/api/jira/sync', async (request) => {
    const body = request.body as { tickets?: IncomingTicket[]; source?: string; replaceAll?: boolean };
    const tickets = Array.isArray(body?.tickets) ? body.tickets : [];
    return syncTickets(db, tickets, {
      source: body?.source ?? 'unknown',
      replaceAll: body?.replaceAll === true,
    });
  });
}

export { DRAFT_SYSTEM_PROMPT };
