/**
 * Work-hours window shared by the background polls (Monday, Jira). A poll that
 * only matters while someone is at the desk should not spend API quota and
 * log lines overnight.
 */
import type { MondayWorkHours as WorkHours } from '@nexus/shared';

export type { WorkHours };

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
export function withinWorkHours(hours: WorkHours | undefined, now: Date = new Date()): boolean {
  if (!hours || !hours.enabled) return true;
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (start === null || end === null || start >= end) return true;
  if (!Array.isArray(hours.days) || hours.days.length === 0) return true;
  if (!hours.days.includes(now.getDay())) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= start && minutes < end;
}

/** Human summary for the startup log line, e.g. "Mon,Tue,Wed,Thu,Fri 08:00–18:00". */
export function describeWorkHours(hours: WorkHours | undefined): string {
  if (!hours?.enabled) return 'always';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [...new Set(hours.days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  return `${days.map((d) => names[d]).join(',')} ${hours.start}–${hours.end}`;
}
