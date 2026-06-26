import { useState, useEffect } from 'react';
import { MissionStatus } from '../api';

interface DaemonToastsProps {
  /** Mission Control status (polled by App); toasts are derived from its health. */
  status: MissionStatus | null;
}

type Level = 'error' | 'warn';
interface Alert {
  id: string;
  level: Level;
  msg: string;
}

const DISMISSED_STORAGE_KEY = 'nexus.daemonToasts.dismissed';

function alertKey(alert: Alert): string {
  return `${alert.id}:${alert.msg}`;
}

function readDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(dismissed: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...dismissed]));
  } catch {
    /* localStorage may be unavailable; in-memory dismissal still works. */
  }
}

/** Derive health alerts from the daemon status that App already polls. */
function deriveAlerts(status: MissionStatus | null): Alert[] {
  if (!status) return [];
  const mem = status.memory;
  // Daemon unreachable → one alert, nothing else is meaningful.
  if (!mem?.ok) return [{ id: 'daemon', level: 'error', msg: 'Memory daemon unreachable (:4100)' }];

  const alerts: Alert[] = [];
  const m = mem.models;
  if (m) {
    if (!m.gen) alerts.push({ id: 'model-gen', level: 'error', msg: 'Generation model unreachable (:4001)' });
    if (!m.embed) alerts.push({ id: 'model-embed', level: 'error', msg: 'Embeddings model unreachable (:4002) — indexing will fail' });
    if (!m.rerank) alerts.push({ id: 'model-rerank', level: 'warn', msg: 'Rerank model unreachable (:4003) — recall degraded' });
  }
  if (mem.jobs && mem.jobs.dead > 0) {
    alerts.push({ id: 'jobs-dead', level: 'warn', msg: `${mem.jobs.dead} memory job(s) failed (dead-lettered)` });
  }
  return alerts;
}

const STYLE: Record<Level, string> = {
  error: 'border-l-red-500',
  warn: 'border-l-amber-500',
};

export default function DaemonToasts({ status }: DaemonToastsProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());

  const active = deriveAlerts(status);
  const activeSetKey = active.map(alertKey).sort().join('|');

  // When the set of active alerts changes, drop dismissals for conditions that
  // have cleared — so a recurring issue can toast again after it's fixed.
  useEffect(() => {
    setDismissed(prev => {
      const activeKeys = new Set(active.map(alertKey));
      const next = new Set([...prev].filter(id => activeKeys.has(id)));
      if (next.size === prev.size) return prev;
      writeDismissed(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSetKey]);

  const visible = active.filter(a => !dismissed.has(alertKey(a)));
  if (visible.length === 0) return null;

  const dismiss = (alert: Alert) => {
    setDismissed(prev => {
      const next = new Set(prev).add(alertKey(alert));
      writeDismissed(next);
      return next;
    });
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {visible.map(a => (
        <div
          key={a.id}
          role="status"
          className={`bg-zinc-900 border border-zinc-800 border-l-2 ${STYLE[a.level]} rounded-md shadow-lg px-3 py-2 flex items-start gap-2`}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/70">
              {a.level === 'error' ? 'Memory · error' : 'Memory · warning'}
            </div>
            <div className="text-sm text-zinc-200 leading-snug">{a.msg}</div>
          </div>
          <button
            onClick={() => dismiss(a)}
            title="Dismiss"
            className="shrink-0 text-zinc-600 hover:text-zinc-200 transition-colors"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
