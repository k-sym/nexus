/**
 * Background refresh of linked Monday items. Ticks only while the backend
 * process runs (a setInterval, not a system cron), matching "sync while I'm in
 * front of Nexus" — the same contract as the Jira poll.
 *
 * Only linked items are refreshed, so cost is flat in board size. Full scope
 * syncs are lazy and driven by the Project Management view instead.
 */
import type Database from 'better-sqlite3';
import type { NexusConfig, MondayWorkHours } from '@nexus/shared';
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
      // Guarded: this function's documented contract is "never throws" (it
      // runs on an unawaited setInterval tick in startMondayPoll). A DB error
      // here (e.g. a locked file) must degrade to a skipped notification, not
      // escape this catch block and violate that contract.
      try {
        insertNotification(db, {
          level: 'error',
          title: 'Monday refresh failed',
          message: `${message}. Check MONDAY_TOKEN and the configured board.`,
        });
      } catch (notifyErr) {
        console.error('[monday] failed to record refresh-failure notification:', (notifyErr as Error)?.message ?? notifyErr);
      }
    }
    return null;
  }
}

/** Parse `HH:MM` into minutes since midnight; null when malformed. */
function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Pure: is `now` inside the configured working window? The window is
 * [start, end) on each listed weekday, evaluated on the server's local clock.
 * A disabled or malformed window means "always on" — a typo in config must
 * not silently switch the poll off for good.
 */
export function withinWorkHours(hours: MondayWorkHours | undefined, now: Date = new Date()): boolean {
  if (!hours || !hours.enabled) return true;
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (start === null || end === null || start >= end) return true;
  if (!Array.isArray(hours.days) || hours.days.length === 0) return true;
  if (!hours.days.includes(now.getDay())) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= start && minutes < end;
}

/** Human summary for the startup log line, e.g. "Mon–Fri 08:00–18:00". */
export function describeWorkHours(hours: MondayWorkHours | undefined): string {
  if (!hours?.enabled) return 'always';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [...new Set(hours.days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  return `${days.map((d) => names[d]).join(',')} ${hours.start}–${hours.end}`;
}

/** Start the interval loop. Returns a stop function. */
export function startMondayPoll(
  db: Database.Database,
  emit?: (event: ActivityEvent) => void,
  now: () => Date = () => new Date(),
): () => void {
  const cfg = loadConfig().monday;
  if (!cfg.enabled) return () => {};

  // Log the work-hours transition once, not every skipped tick: a quiet
  // overnight poll would otherwise fill the log with "skipped" lines, which is
  // the noise this gate exists to remove.
  let quiet = false;
  const tick = () => {
    const current = loadConfig().monday;
    if (!withinWorkHours(current.work_hours, now())) {
      if (!quiet) {
        quiet = true;
        console.log(`[monday] outside work hours (${describeWorkHours(current.work_hours)}) — poll paused`);
      }
      return;
    }
    if (quiet) {
      quiet = false;
      console.log('[monday] inside work hours — poll resumed');
    }
    void runMondayRefreshOnce(db, current, resolveMondayToken(), undefined, emit);
  };
  console.log(`[monday] poll started — every ${cfg.poll_minutes}m, work hours ${describeWorkHours(cfg.work_hours)}`);
  const handle = setInterval(tick, Math.max(1, cfg.poll_minutes) * 60_000);
  tick();
  return () => clearInterval(handle);
}
