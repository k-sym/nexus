import { useCallback, useEffect, useState } from 'react';
import { HardDrives, Trash } from '@phosphor-icons/react';
import { fetchDockerServices, dockerServiceDown, type ServiceGroup } from '../api';
import { confirmDialog } from '../lib/confirm';

/** Poll cadence while a session is open. Containers change on human timescales. */
const POLL_MS = 5_000;

function stateDot(state: string): string {
  const s = state.toLowerCase();
  if (s === 'running') return 'bg-emerald-500';
  if (s === 'restarting' || s === 'created' || s === 'paused') return 'bg-amber-500';
  return 'bg-zinc-500';
}

/**
 * The Docker services THIS thread has running, shown inline in its chat session
 * so a developer doesn't have to leave the conversation to check (#282). Renders
 * nothing when the thread has no services — sessions that never touched Docker
 * see no chrome at all.
 */
export default function ThreadServicesPanel({ threadId }: { threadId: string | null }) {
  const [group, setGroup] = useState<ServiceGroup | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!threadId) { setGroup(null); return; }
    try {
      const res = await fetchDockerServices(threadId);
      // The endpoint returns at most this thread's one group.
      setGroup(res.available ? res.groups[0] ?? null : null);
    } catch {
      // A transient failure shouldn't yank the panel; keep the last known state.
    }
  }, [threadId]);

  useEffect(() => {
    setGroup(null); // don't show the previous thread's services while the new one loads
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const tearDown = useCallback(async () => {
    if (!group) return;
    if (!(await confirmDialog('Stop and remove this session\'s Docker services?'))) return;
    setBusy(true);
    try {
      await dockerServiceDown(group.project);
      await load();
    } catch { /* the next poll reflects reality */ } finally {
      setBusy(false);
    }
  }, [group, load]);

  if (!group || group.containers.length === 0) return null;

  const running = group.containers.filter((c) => c.state.toLowerCase() === 'running').length;

  return (
    <div className="mx-4 mt-2 rounded-md border border-zinc-800 bg-zinc-900/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800/60">
        <HardDrives size={13} className="accent-text shrink-0" />
        <span className="text-zinc-300">Services</span>
        <span className="text-zinc-500">{running}/{group.containers.length} running</span>
        <div className="flex-1" />
        <button
          onClick={() => { void tearDown(); }}
          disabled={busy}
          className="flex items-center gap-1 text-zinc-500 hover:text-red-300 disabled:opacity-50 transition-colors"
        >
          <Trash size={12} /> {busy ? 'Stopping…' : 'Tear down'}
        </button>
      </div>
      <div className="divide-y divide-zinc-800/40">
        {group.containers.map((c) => (
          <div key={c.name} className="flex items-center gap-2 px-3 py-1.5">
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${stateDot(c.state)}`} title={c.status} />
            <span className="font-mono text-zinc-300 truncate">{c.name}</span>
            <div className="flex-1" />
            {c.ports && <span className="font-mono text-zinc-500 shrink-0 truncate max-w-[50%]" title={c.ports}>{c.ports}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
