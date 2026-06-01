/**
 * Tickets — a disposable mirror of Jira tickets assigned to the user.
 *
 * `POST /api/jira/sync` matches the contract of the existing cron
 * (~/Projects/baker-internal/scripts/jira-sync.sh, run by the OpenClaw "Nigel"
 * agent): it accepts { tickets, source, replaceAll } and returns
 * { inserted, updated, removed } — so the script needs no changes, only its
 * MC_URL repointed at Nexus. Jira stays canonical; Nexus never writes back.
 */
import { FastifyInstance } from 'fastify';

interface IncomingTicket {
  key: string;
  summary?: string;
  status?: string;
  priority?: string;
  assignee?: string | null;
  created?: string;
  updated?: string;
  url?: string;
}

export async function registerTicketRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/tickets', async () => {
    return db.prepare('SELECT * FROM tickets ORDER BY datetime(updated) DESC, key DESC').all();
  });

  fastify.post('/api/jira/sync', async (request) => {
    const body = request.body as { tickets?: IncomingTicket[]; source?: string; replaceAll?: boolean };
    const tickets = Array.isArray(body?.tickets) ? body.tickets : [];
    const source = body?.source ?? 'unknown';
    const replaceAll = body?.replaceAll === true;
    const now = new Date().toISOString();

    const existing = new Set(
      (db.prepare('SELECT key FROM tickets').all() as { key: string }[]).map(r => r.key),
    );
    const incomingKeys = new Set<string>();

    const upsert = db.prepare(`
      INSERT INTO tickets (key, summary, status, priority, assignee, created, updated, url, source, synced_at)
      VALUES (@key, @summary, @status, @priority, @assignee, @created, @updated, @url, @source, @synced_at)
      ON CONFLICT(key) DO UPDATE SET
        summary = excluded.summary, status = excluded.status, priority = excluded.priority,
        assignee = excluded.assignee, created = excluded.created, updated = excluded.updated,
        url = excluded.url, source = excluded.source, synced_at = excluded.synced_at
    `);
    const del = db.prepare('DELETE FROM tickets WHERE key = ?');

    let inserted = 0;
    let updated = 0;
    let removed = 0;

    const sync = db.transaction(() => {
      for (const t of tickets) {
        if (!t?.key) continue;
        incomingKeys.add(t.key);
        upsert.run({
          key: t.key,
          summary: t.summary ?? '',
          status: t.status ?? '',
          priority: t.priority ?? '',
          assignee: t.assignee ?? null,
          created: t.created ?? null,
          updated: t.updated ?? null,
          url: t.url ?? null,
          source,
          synced_at: now,
        });
        if (existing.has(t.key)) updated++;
        else inserted++;
      }
      if (replaceAll) {
        for (const k of existing) {
          if (!incomingKeys.has(k)) {
            del.run(k);
            removed++;
          }
        }
      }
    });
    sync();

    return { inserted, updated, removed };
  });
}
