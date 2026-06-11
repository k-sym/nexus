/**
 * Tickets — a disposable mirror of Jira tickets assigned to the user.
 *
 * `POST /api/jira/sync` is the push path (the legacy OpenClaw "Nigel" cron). The
 * native poll (jira/poll.ts) shares the same syncTickets() upsert. Jira stays
 * canonical; Nexus never writes back.
 */
import { FastifyInstance } from 'fastify';
import { syncTickets, type IncomingTicket } from '../tickets/sync.js';

export async function registerTicketRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/tickets', async () => {
    return db.prepare('SELECT * FROM tickets ORDER BY datetime(updated) DESC, key DESC').all();
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
