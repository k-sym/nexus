/**
 * Native Jira poll. Ticks only while the backend process runs (a setInterval,
 * not a system cron) — matching "sync while I'm in front of Nexus". Gated on
 * jira.enabled + JIRA_TOKEN; emits a notification on change or error, silent on
 * no-op.
 */
import type Database from 'better-sqlite3';
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { fetchJiraTickets, type JiraQueryConfig } from './client.js';
import { syncTickets, type IncomingTicket, type SyncResult } from '../tickets/sync.js';
import { insertNotification } from '../notifications/index.js';

type JiraConfig = NexusConfig['jira'];
type FetchTickets = (cfg: JiraQueryConfig, token: string) => Promise<IncomingTicket[]>;

/**
 * Run one sync. Returns the SyncResult, or null when dormant (disabled / no token)
 * or when the fetch failed (an error notification is recorded instead). Never throws.
 * `fetchTickets` is injectable for tests.
 */
export async function runJiraSyncOnce(
  db: Database.Database,
  jira: JiraConfig,
  token: string | undefined,
  fetchTickets: FetchTickets = (cfg, tok) => fetchJiraTickets(cfg, tok),
): Promise<SyncResult | null> {
  if (!jira.enabled || !token) return null;

  try {
    const tickets = await fetchTickets({ user: jira.user, instance: jira.instance, project: jira.project }, token);
    const existingCount = (db.prepare('SELECT COUNT(*) AS count FROM tickets').get() as { count: number }).count;
    if (tickets.length === 0 && existingCount > 0) {
      insertNotification(db, {
        level: 'error',
        title: 'Jira sync skipped',
        message: `Jira returned zero tickets; kept ${existingCount} existing mirrored ticket${existingCount === 1 ? '' : 's'}. Check JIRA_TOKEN, account email, and Jira assignment before clearing.`,
      });
      return null;
    }
    const res = syncTickets(db, tickets, { source: 'nexus', replaceAll: true });
    if (res.inserted + res.updated + res.removed > 0) {
      insertNotification(db, {
        level: 'info',
        title: 'Jira',
        message: `${res.inserted} new, ${res.updated} updated, ${res.removed} removed`,
      });
    }
    return res;
  } catch (err) {
    insertNotification(db, { level: 'error', title: 'Jira sync failed', message: (err as Error).message });
    return null;
  }
}

/**
 * Start the poll. Reads config + JIRA_TOKEN once; if dormant, logs a single line
 * and does nothing. Otherwise runs immediately, then every poll_minutes.
 */
export function startJiraSync(db: Database.Database): { stop: () => void } {
  const jira = loadConfig().jira;
  const token = process.env.JIRA_TOKEN;

  if (!jira.enabled) {
    console.log('[jira] disabled in settings — poll dormant');
    return { stop: () => {} };
  }
  if (!token) {
    console.log('[jira] enabled but JIRA_TOKEN not set in env — poll dormant');
    return { stop: () => {} };
  }

  const everyMs = Math.max(1, jira.poll_minutes) * 60_000;
  console.log(`[jira] poll started — ${jira.project} every ${jira.poll_minutes}m`);
  void runJiraSyncOnce(db, jira, token);
  const timer = setInterval(() => void runJiraSyncOnce(db, jira, token), everyMs);
  return { stop: () => clearInterval(timer) };
}
