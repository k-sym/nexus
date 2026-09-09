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
import { ActivityEvent } from '../activity/events.js';
import { ActivityManager } from '../activity/manager.js';
import { withinWorkHours, describeWorkHours } from '../work-hours.js';

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
  emit?: (event: ActivityEvent) => void,
): Promise<SyncResult | null> {
  if (!jira.enabled || !token) return null;

  const operationId = crypto.randomUUID();
  emit?.({
    type: 'start',
    operationId,
    kind: 'jira_sync',
    title: 'Jira sync',
  });

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
    emit?.({
      type: 'stop',
      operationId,
      kind: 'jira_sync',
      title: 'Jira sync',
      status: 'succeeded',
      diagnostics: { inserted: res.inserted, updated: res.updated, removed: res.removed },
    });
    if (res.inserted + res.updated + res.removed > 0) {
      insertNotification(db, {
        level: 'info',
        title: 'Jira',
        message: `${res.inserted} new, ${res.updated} updated, ${res.removed} removed`,
      });
    }
    return res;
  } catch (err) {
    const message = (err as Error).message;
    emit?.({
      type: 'stop',
      operationId,
      kind: 'jira_sync',
      title: 'Jira sync',
      status: 'failed',
      error: message,
    });
    insertNotification(db, { level: 'error', title: 'Jira sync failed', message });
    return null;
  }
}

export interface StartJiraSyncDeps {
  /** Test seam: the clock the work-hours gate reads. */
  now?: () => Date;
  /** Test seam: replaces the Jira REST fetch. */
  fetchTickets?: FetchTickets;
}

/**
 * Start the poll. Reads config + JIRA_TOKEN once; if dormant, logs a single line
 * and does nothing. Otherwise ticks immediately, then every poll_minutes; a tick
 * outside `jira.work_hours` is skipped (logged once per transition, not per tick).
 */
export function startJiraSync(db: Database.Database, activity?: ActivityManager, deps: StartJiraSyncDeps = {}): { stop: () => void } {
  const jira = loadConfig().jira;
  const token = process.env.JIRA_TOKEN;
  const now = deps.now ?? (() => new Date());

  if (!jira.enabled) {
    console.log('[jira] disabled in settings — poll dormant');
    return { stop: () => {} };
  }
  if (!token) {
    console.log('[jira] enabled but JIRA_TOKEN not set in env — poll dormant');
    return { stop: () => {} };
  }

  const everyMs = Math.max(1, jira.poll_minutes) * 60_000;
  const emit = activity?.bus.emit.bind(activity.bus);
  let quiet = false;
  const tick = () => {
    if (!withinWorkHours(jira.work_hours, now())) {
      if (!quiet) {
        quiet = true;
        console.log(`[jira] outside work hours (${describeWorkHours(jira.work_hours)}) — poll paused`);
      }
      return;
    }
    if (quiet) {
      quiet = false;
      console.log('[jira] inside work hours — poll resumed');
    }
    void runJiraSyncOnce(db, jira, token, deps.fetchTickets, emit);
  };
  console.log(`[jira] poll started — ${jira.project} every ${jira.poll_minutes}m, work hours ${describeWorkHours(jira.work_hours)}`);
  tick();
  const timer = setInterval(tick, everyMs);
  return { stop: () => clearInterval(timer) };
}
