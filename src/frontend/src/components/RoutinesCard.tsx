import { useCallback, useEffect, useState } from 'react';
import { api, Routine, RoutineDetail, RoutineHealth, RoutinesResponse } from '../api';

// Partner routine fleet card (baker-internal#82) — read-only by design: no
// start/stop controls in v1. Dot vocabulary mirrors the Sidebar activity dots
// (emerald/amber/red) with zinc for "hasn't run yet".
const POLL_MS = 60_000;

const HEALTH_DOT: Record<RoutineHealth, string> = {
  ok: 'bg-emerald-400',
  stale: 'bg-amber-400',
  failed: 'bg-red-500',
  pending: 'bg-zinc-600',
};

const HEALTH_LABEL: Record<RoutineHealth, string> = {
  ok: 'last run succeeded',
  stale: 'missed its scheduled slot',
  failed: 'last run failed',
  pending: 'not run yet',
};

function relativeAgo(epochSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (elapsed < 60) return 'just now';
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function nextDueLabel(epochSeconds: number): string {
  const due = new Date(epochSeconds * 1000);
  const time = due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (due.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (due.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${due.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function lastRunSummary(routine: Routine): string {
  const last = routine.last_run;
  const anchor = last?.ended ?? last?.started;
  if (!anchor) return 'never run';
  if (routine.health === 'failed' && last) {
    return `failed ${relativeAgo(anchor)}${last.timed_out ? ' (timed out)' : last.rc != null ? ` (rc ${last.rc})` : ''}`;
  }
  return `ran ${relativeAgo(anchor)}`;
}

function RoutineRow({ routine }: { routine: Routine }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<RoutineDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) {
      try {
        setDetail(await api.routines.get(routine.name));
      } catch (err: any) {
        setDetailError(err?.message || 'Failed to load detail.');
      }
    }
  };

  return (
    <div className="border-b border-subtle last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)] transition-colors rounded-sm px-1"
        title={HEALTH_LABEL[routine.health]}
        aria-label={`${routine.name}: ${HEALTH_LABEL[routine.health]}`}
      >
        <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${HEALTH_DOT[routine.health]}`} />
        <span className="text-xs font-medium text-zinc-200 truncate">{routine.name}</span>
        <span className="text-[11px] text-muted ml-auto shrink-0">{lastRunSummary(routine)}</span>
        {routine.next_due != null && (
          <span className="text-[11px] text-faint shrink-0">next {nextDueLabel(routine.next_due)}</span>
        )}
      </button>
      {expanded && (
        <div className="px-1 pb-2 text-[11px] text-muted space-y-1">
          <div>
            {routine.schedule_display}
            {routine.last_run?.rc != null && ` · rc ${routine.last_run.rc}`}
            {routine.last_run?.timed_out && ' · timed out'}
            {routine.last_run?.source === 'stamp' && ' · legacy stamp'}
          </div>
          {detailError && <div className="text-red-400">{detailError}</div>}
          {detail && detail.log_tail.length > 0 && (
            <pre className="text-[10px] leading-4 text-faint bg-[var(--surface-hover)] rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
              {detail.log_tail.join('\n')}
            </pre>
          )}
          {detail && detail.log_tail.length === 0 && <div className="text-faint">No log output.</div>}
        </div>
      )}
    </div>
  );
}

export default function RoutinesCard() {
  const [report, setReport] = useState<RoutinesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.routines.list());
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load routines.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const routines = report?.routines ?? [];
  const attention = routines.filter((r) => r.health === 'failed' || r.health === 'stale').length;

  return (
    <div className="surface-glass rounded-xl border border-subtle p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium">Routines</div>
        {routines.length > 0 && (
          <div className={`text-[10px] ${attention > 0 ? 'text-amber-400' : 'text-faint'}`}>
            {attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} attention` : 'all healthy'}
          </div>
        )}
      </div>
      {report == null && !loadError && <div className="text-xs text-faint">Loading routines…</div>}
      {loadError && <div className="text-xs text-red-400">{loadError}</div>}
      {report?.configured === false && (
        <div className="text-xs text-faint">Configure the assistant URL and key in Settings to see routines.</div>
      )}
      {report?.error && <div className="text-xs text-faint">Adapter unreachable · {report.error}</div>}
      {report?.configured !== false && !report?.error && routines.length === 0 && report != null && !loadError && (
        <div className="text-xs text-faint">No scheduled routines found.</div>
      )}
      {routines.map((routine) => (
        <RoutineRow key={routine.name} routine={routine} />
      ))}
    </div>
  );
}
