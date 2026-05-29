/**
 * Minimal cron expression parser and next-run calculator.
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 *   *            any value
 *   5            specific value
 *   1,3,5        list
 *   1-5          range
 *   * / 15       step (written without the space)
 *
 * Day-of-week: 0-6 (Sunday=0). Month: 1-12.
 */

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const lo = range === '*' ? min : parseInt(range.split('-')[0], 10);
      const hi = range === '*' || !range.includes('-') ? max : parseInt(range.split('-')[1], 10);
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(n => parseInt(n, 10));
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return Array.from(values).filter(v => v >= min && v <= max).sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    const fields: CronFields = {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dayOfMonth: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dayOfWeek: parseField(parts[4], 0, 6),
    };
    // A field that produced no valid values (e.g. "abc" or "99") is invalid —
    // it would silently never fire otherwise.
    if (Object.values(fields).some(vals => vals.length === 0)) return null;
    return fields;
  } catch {
    return null;
  }
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/**
 * Calculate the next run time strictly after `from`.
 * Scans minute-by-minute up to ~366 days ahead.
 */
export function getNextRun(expr: string, from: Date = new Date()): Date | null {
  const fields = parseCron(expr);
  if (!fields) return null;

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (
      fields.minute.includes(candidate.getMinutes()) &&
      fields.hour.includes(candidate.getHours()) &&
      fields.dayOfMonth.includes(candidate.getDate()) &&
      fields.month.includes(candidate.getMonth() + 1) &&
      fields.dayOfWeek.includes(candidate.getDay())
    ) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Human-readable description of common cron patterns (best-effort).
 */
export function describeCron(expr: string): string {
  const presets: Record<string, string> = {
    '0 9 * * *': 'Every day at 9:00 AM',
    '0 0 * * *': 'Every day at midnight',
    '0 9 * * 1': 'Every Monday at 9:00 AM',
    '0 9 * * 1-5': 'Every weekday at 9:00 AM',
    '0 * * * *': 'Every hour',
    '*/15 * * * *': 'Every 15 minutes',
    '0 0 * * 0': 'Every Sunday at midnight',
    '0 12 * * *': 'Every day at noon',
  };
  return presets[expr.trim()] || `Cron: ${expr}`;
}
