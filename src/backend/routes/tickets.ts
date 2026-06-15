/**
 * Tickets — a disposable mirror of Jira tickets assigned to the user.
 *
 * `POST /api/jira/sync` is the push path (the legacy OpenClaw "Nigel" cron). The
 * native poll (jira/poll.ts) shares the same syncTickets() upsert. Jira stays
 * canonical; Nexus never writes back.
 */
import { FastifyInstance } from 'fastify';
import { syncTickets, type IncomingTicket } from '../tickets/sync.js';
import { cleanAdf, type AdfNode } from '../tickets/cleanAdf.js';
import { fetchJiraIssueDescription } from '../jira/client.js';
import { loadConfig } from '../config.js';

export async function registerTicketRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/tickets', async () => {
    return db.prepare('SELECT * FROM tickets ORDER BY datetime(updated) DESC, key DESC').all();
  });

  fastify.get('/api/tickets/:key/description', async (request, reply) => {
    const { key } = request.params as { key: string };
    const refresh = (request.query as { refresh?: string }).refresh != null;

    const row = db.prepare('SELECT key, description_adf, description_fetched_at FROM tickets WHERE key = ?')
      .get(key) as { key: string; description_adf: string | null; description_fetched_at: string | null } | undefined;
    if (!row) {
      const err = new Error('Ticket not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const config = loadConfig();
    const rules = config.jira.content_rules ?? [];

    const respond = (adfJson: string | null, fetchedAt: string | null) => {
      if (!adfJson) return { key, body: '', trimmed: [], fetchedAt, empty: true };
      let adf: AdfNode | null = null;
      try { adf = JSON.parse(adfJson) as AdfNode; } catch { adf = null; }
      const cleaned = cleanAdf(adf, rules);
      return { key, body: cleaned.body, trimmed: cleaned.trimmed, fetchedAt, empty: cleaned.body.length === 0 };
    };

    if (row.description_adf && !refresh) {
      return respond(row.description_adf, row.description_fetched_at);
    }

    const token = process.env.JIRA_TOKEN;
    if (!config.jira.enabled || !config.jira.user || !config.jira.instance || !token) {
      // Not configured to fetch — return cache if any, else empty.
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
      db.prepare('UPDATE tickets SET description_adf = ?, description_fetched_at = ? WHERE key = ?')
        .run(adfJson, fetchedAt, key);
      return respond(adfJson, fetchedAt);
    } catch (err) {
      reply.status(502);
      return { key, body: '', trimmed: [], fetchedAt: row.description_fetched_at, empty: true, error: (err as Error).message };
    }
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
