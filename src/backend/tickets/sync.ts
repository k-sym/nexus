/**
 * Shared Jira-ticket upsert. Used by both the push endpoint (POST /api/jira/sync)
 * and the native poll (jira/poll.ts). Jira stays canonical; Nexus never writes back.
 */
import type Database from 'better-sqlite3';

export interface IncomingTicket {
  key: string;
  summary?: string;
  status?: string;
  priority?: string;
  assignee?: string | null;
  created?: string | null;
  updated?: string | null;
  url?: string | null;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  removed: number;
}

export function syncTickets(
  db: Database.Database,
  tickets: IncomingTicket[],
  opts: { source: string; replaceAll: boolean },
): SyncResult {
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

  const run = db.transaction(() => {
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
        source: opts.source,
        synced_at: now,
      });
      if (existing.has(t.key)) updated++;
      else inserted++;
    }
    if (opts.replaceAll) {
      for (const k of existing) {
        if (!incomingKeys.has(k)) {
          del.run(k);
          removed++;
        }
      }
    }
  });
  run();

  return { inserted, updated, removed };
}
