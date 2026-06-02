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
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const active = deriveAlerts(status);
  const activeKey = active.map(a => a.id).sort().join('|');

  // When the set of active alerts changes, drop dismissals for conditions that
  // have cleared — so a recurring issue can toast again after it's fixed.
  useEffect(() => {
    setDismissed(prev => {
      const ids = new Set(active.map(a => a.id));
      const next = new Set([...prev].filter(id => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const visible = active.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

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
            onClick={() => setDismissed(prev => new Set(prev).add(a.id))}
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
