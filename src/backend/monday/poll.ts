/**
 * Background refresh of linked Monday items. Ticks only while the backend
 * process runs (a setInterval, not a system cron), matching "sync while I'm in
 * front of Nexus" — the same contract as the Jira poll.
 *
 * Only linked items are refreshed, so cost is flat in board size. Full scope
 * syncs are lazy and driven by the Project Management view instead.
 */
import type Database from 'better-sqlite3';
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { refreshLinkedItems } from './sync.js';
import type { MondayClientOptions } from './client.js';
import { insertNotification } from '../notifications/index.js';
import type { ActivityEvent } from '../activity/events.js';

type MondayConfig = NexusConfig['monday'];
type Refresh = (db: Database.Database, opts: MondayClientOptions, now: string) => Promise<number>;

/** The token comes from the environment only — never config, never the DB. */
export function resolveMondayToken(): string | undefined {
  const token = process.env.MONDAY_TOKEN?.trim();
  return token ? token : undefined;
}

// Last error message notified about, per-process. Suppresses a flood of
// identical "Monday sync failed" toasts when the same 401 recurs every tick.
let lastErrorMessage: string | null = null;

/** Test-only: clear the deduped-error state. */
export function __resetPollErrorState(): void {
  lastErrorMessage = null;
}

/**
 * Run one linked-item refresh. Returns the count refreshed, or null when
 * dormant (disabled / no token) or when the refresh failed. Never throws.
 */
export async function runMondayRefreshOnce(
  db: Database.Database,
  cfg: MondayConfig,
  token: string | undefined,
  refresh: Refresh = (database, opts, now) => refreshLinkedItems(database, opts, now),
  emit?: (event: ActivityEvent) => void,
): Promise<number | null> {
  if (!cfg.enabled || !token) return null;

  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  emit?.({ type: 'start', operationId, kind: 'monday_sync', title: 'Monday refresh' });

  try {
    const count = await refresh(db, { token, apiVersion: cfg.api_version }, new Date().toISOString());
    lastErrorMessage = null;
    emit?.({
      type: 'stop', operationId, kind: 'monday_sync', title: 'Monday refresh',
      status: 'succeeded', durationMs: Date.now() - startedAt,
    });
    return count;
  } catch (err) {
    const message = (err as Error).message;
    emit?.({
      type: 'stop', operationId, kind: 'monday_sync', title: 'Monday refresh',
      status: 'failed', durationMs: Date.now() - startedAt, error: message,
    });
    if (lastErrorMessage !== message) {
      lastErrorMessage = message;
      insertNotification(db, {
        level: 'error',
        title: 'Monday refresh failed',
        message: `${message}. Check MONDAY_TOKEN and the configured board.`,
      });
    }
    return null;
  }
}

/** Start the interval loop. Returns a stop function. */
export function startMondayPoll(
  db: Database.Database,
  emit?: (event: ActivityEvent) => void,
): () => void {
  const cfg = loadConfig().monday;
  if (!cfg.enabled) return () => {};

  const tick = () => {
    void runMondayRefreshOnce(db, loadConfig().monday, resolveMondayToken(), undefined, emit);
  };
  const handle = setInterval(tick, Math.max(1, cfg.poll_minutes) * 60_000);
  tick();
  return () => clearInterval(handle);
}
