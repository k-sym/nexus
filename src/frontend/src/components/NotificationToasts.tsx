import { useEffect, useRef, useState } from 'react';
import { api, NotificationItem } from '../api';

const POLL_MS = 15000;
const AUTO_DISMISS_MS = 8000;

const STYLE: Record<NotificationItem['level'], string> = {
  info: 'border-l-indigo-500',
  error: 'border-l-red-500',
};

/**
 * Polls /api/notifications for unseen rows, shows each as a toast in the
 * bottom-right stack, and marks them seen so they appear once. Sits alongside
 * DaemonToasts (which renders derived health alerts).
 */
export default function NotificationToasts() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const unseen = await api.notifications.list();
        if (!active || unseen.length === 0) return;
        const fresh = unseen.filter(n => !seenRef.current.has(n.id));
        if (fresh.length === 0) return;
        fresh.forEach(n => seenRef.current.add(n.id));
        setItems(prev => [...fresh, ...prev]);
        // Mark seen server-side so they don't return on the next poll.
        await api.notifications.seen(fresh.map(n => n.id));
        // Auto-dismiss each after a short delay.
        fresh.forEach(n => setTimeout(() => {
          if (active) setItems(prev => prev.filter(x => x.id !== n.id));
        }, AUTO_DISMISS_MS));
      } catch {
        /* transient; try again next tick */
      }
    };
    void tick();
    const interval = setInterval(tick, POLL_MS);
    return () => { active = false; clearInterval(interval); };
  }, []);

  if (items.length === 0) return null;

  const dismiss = (id: string) => setItems(prev => prev.filter(x => x.id !== id));

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {items.map(n => (
        <div
          key={n.id}
          role="status"
          className={`bg-zinc-900 border border-zinc-800 border-l-2 ${STYLE[n.level]} rounded-md shadow-lg px-3 py-2 flex items-start gap-2`}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/70">{n.title}</div>
            <div className="text-sm text-zinc-200 leading-snug">{n.message}</div>
          </div>
          <button
            onClick={() => dismiss(n.id)}
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
