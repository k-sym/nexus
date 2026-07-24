import { useCallback, useEffect, useState } from 'react';
import { HardDrives, ArrowClockwise, Warning, Trash } from '@phosphor-icons/react';
import { fetchDockerServices, dockerServiceDown, type ServiceGroup } from '../api';
import { confirmDialog } from '../lib/confirm';

/** Poll cadence while the view is open. Containers change on human timescales,
 *  so this is unhurried. */
const POLL_MS = 5_000;

/** A coloured dot per container state — running is the only "good" one. */
function stateDot(state: string): string {
  const s = state.toLowerCase();
  if (s === 'running') return 'bg-emerald-500';
  if (s === 'restarting' || s === 'created' || s === 'paused') return 'bg-amber-500';
  return 'bg-zinc-500'; // exited, dead, removing
}

/** Trailing thread slug of a compose project name, for a friendlier label. */
function shortProject(project: string): string {
  return project.startsWith('nexus-') ? project.slice('nexus-'.length) : project;
}

export default function ServicesView() {
  const [available, setAvailable] = useState(true);
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchDockerServices();
      setAvailable(res.available);
      setGroups(res.groups);
      setError(null);
    } catch {
      // Don't leave a stale group list showing as if it were current, and don't
      // let the "nothing running" empty state claim knowledge we don't have.
      setGroups([]);
      setError('Could not reach the backend.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const tearDown = useCallback(async (project: string, orphaned: boolean) => {
    const ok = await confirmDialog(
      `Stop and remove all containers in ${shortProject(project)}?`
      + (orphaned ? '' : ' A session still owns this stack.'),
    );
    if (!ok) return;
    setBusy(project);
    try {
      await dockerServiceDown(project);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Teardown failed.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const orphanCount = groups.filter((g) => g.orphaned).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <div className="flex items-center gap-3">
          <HardDrives size={20} className="accent-text" />
          <h1 className="text-lg font-semibold text-zinc-100">Docker services</h1>
          <div className="flex-1" />
          {orphanCount > 0 && (
            <span className="text-xs text-amber-400 flex items-center gap-1">
              <Warning size={14} weight="fill" /> {orphanCount} orphaned
            </span>
          )}
          <button
            onClick={() => { void load(); }}
            title="Refresh"
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <ArrowClockwise size={16} />
          </button>
        </div>

        <p className="text-xs text-zinc-500 leading-relaxed">
          Compose services Nexus sessions have started. A group flagged <span className="text-amber-400">orphaned</span> is
          owned by no live session — a leftover from a crash or a closed thread — and is safe to remove.
        </p>

        {error && <div className="text-xs text-red-400 border-l-2 border-l-red-500 pl-2">{error}</div>}

        {!loaded ? (
          <div className="text-sm text-zinc-500 py-8 text-center">Loading…</div>
        ) : !available ? (
          <div className="text-sm text-zinc-500 py-8 text-center">
            Docker isn't reachable. Start Docker (and enable it in Settings) to run project services.
          </div>
        ) : error ? (
          // The error banner above already explains; don't also claim "nothing
          // running" when we couldn't actually read the list.
          null
        ) : groups.length === 0 ? (
          <div className="text-sm text-zinc-500 py-8 text-center">No services are running.</div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div
                key={group.project}
                className={`rounded-lg border bg-zinc-900/50 ${group.orphaned ? 'border-amber-500/40' : 'border-zinc-800'}`}
              >
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800/70">
                  <span className="text-sm font-mono text-zinc-200">{shortProject(group.project)}</span>
                  {group.orphaned && (
                    <span className="text-[10px] uppercase tracking-wider text-amber-400 border border-amber-500/40 rounded px-1.5 py-0.5">
                      orphaned
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={() => { void tearDown(group.project, group.orphaned); }}
                    disabled={busy === group.project}
                    className="text-xs flex items-center gap-1 text-zinc-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                  >
                    <Trash size={13} /> {busy === group.project ? 'Stopping…' : 'Tear down'}
                  </button>
                </div>
                <div className="divide-y divide-zinc-800/50">
                  {group.containers.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 px-4 py-2 text-xs">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${stateDot(c.state)}`} title={c.status} />
                      <span className="font-mono text-zinc-300 truncate">{c.name}</span>
                      <span className="text-zinc-600 shrink-0">{c.image}</span>
                      <div className="flex-1" />
                      {c.ports
                        ? <span className="font-mono text-zinc-500 shrink-0 truncate max-w-[45%]" title={c.ports}>{c.ports}</span>
                        : <span className="text-zinc-600 shrink-0">{c.status}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
