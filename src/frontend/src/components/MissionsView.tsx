import { useCallback, useEffect, useState } from 'react';
import { Play, Pause, Stop, Trash, Plus } from '@phosphor-icons/react';
import type { Project, Mission, MissionRun, CreateMissionInput, MissionKind, MissionPacing } from '@nexus/shared';
import { api } from '../api';

const KINDS: MissionKind[] = ['echo', 'triage_tickets', 'review_stale_tasks', 'assistant_turn'];
const PACINGS: MissionPacing[] = ['fixed', 'self_paced', 'backlog_drain'];

interface Props {
  projects: Project[];
}

const emptyDraft = (): CreateMissionInput => ({
  title: '', kind: 'echo', pacing: 'fixed', interval_seconds: 3600, max_iterations: 10,
});

export default function MissionsView({ projects }: Props) {
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState<Mission | null>(null);
  const [runs, setRuns] = useState<MissionRun[]>([]);
  const [draft, setDraft] = useState<CreateMissionInput>(emptyDraft());
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.missions.listForProject(projectId);
      setMissions(data);
      setSelected((prev) => (prev ? data.find((m) => m.id === prev.id) ?? null : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load missions');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // Poll while any mission is active (matches the app's polling convention).
  useEffect(() => {
    if (!missions.some((m) => m.status === 'active')) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [missions, load]);

  const selectMission = useCallback(async (m: Mission) => {
    setSelected(m);
    try { setRuns(await api.missions.runs(m.id)); } catch { setRuns([]); }
  }, []);

  const handleCreate = async () => {
    setError(null);
    if (!draft.title?.trim()) { setError('Title is required'); return; }
    try {
      await api.missions.create(projectId, draft);
      setDraft(emptyDraft());
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const control = async (m: Mission, action: 'resume' | 'pause' | 'stop') => {
    try {
      await api.missions[action](m.id);
      await load();
      if (selected?.id === m.id) await selectMission(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    }
  };

  const remove = async (m: Mission) => {
    await api.missions.delete(m.id);
    if (selected?.id === m.id) { setSelected(null); setRuns([]); }
    await load();
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: list + create */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <h1 className="text-xl font-semibold text-zinc-100">Missions</h1>
          <div className="flex items-center gap-2">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="bg-zinc-900 rounded-lg border border-zinc-800 px-2 py-1 text-sm text-zinc-200"
            >
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={() => setShowCreate((v) => !v)}
              className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
            >
              <Plus size={16} /> New
            </button>
          </div>
        </header>

        {error && (
          <div className="mx-6 mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {showCreate && (
          <div className="mx-6 mt-3 bg-zinc-900 rounded-xl border border-zinc-800 p-4 space-y-3">
            <input
              autoFocus
              placeholder="Mission title…"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="w-full rounded-lg border border-zinc-800 bg-transparent px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/60"
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-zinc-500">Kind
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as MissionKind })}
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-transparent px-2 py-1.5 text-sm text-zinc-200"
                >
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className="text-xs text-zinc-500">Pacing
                <select
                  value={draft.pacing}
                  onChange={(e) => setDraft({ ...draft, pacing: e.target.value as MissionPacing })}
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-transparent px-2 py-1.5 text-sm text-zinc-200"
                >
                  {PACINGS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="text-xs text-zinc-500">Interval (seconds)
                <input
                  type="number"
                  value={draft.interval_seconds ?? 3600}
                  onChange={(e) => setDraft({ ...draft, interval_seconds: Number(e.target.value) })}
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-transparent px-2 py-1.5 text-sm text-zinc-200"
                />
              </label>
              <label className="text-xs text-zinc-500">Max iterations
                <input
                  type="number"
                  value={draft.max_iterations ?? 0}
                  onChange={(e) => setDraft({ ...draft, max_iterations: Number(e.target.value) || null })}
                  className="mt-1 w-full rounded-lg border border-zinc-800 bg-transparent px-2 py-1.5 text-sm text-zinc-200"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
              >
                Create (paused)
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-2">
          {missions.length === 0 && (
            <p className="text-sm text-zinc-600 text-center py-10">No missions yet. Create one — it starts paused.</p>
          )}
          {missions.map((m) => (
            <button
              key={m.id}
              onClick={() => void selectMission(m)}
              className={`group block w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                selected?.id === m.id ? 'border-indigo-500/60' : 'border-zinc-800 hover:border-zinc-700'
              } bg-zinc-900`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-200">{m.title}</span>
                <StatusBadge status={m.status} />
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500">
                <span>{m.kind}</span>
                <span>{m.pacing}</span>
                <span>{m.iteration_count}{m.max_iterations != null ? `/${m.max_iterations}` : ''} runs</span>
                {m.stop_reason && <span>stopped: {m.stop_reason}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: detail + controls + ledger */}
      <div className="w-[28rem] border-l border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0">
        {selected ? (
          <div className="flex flex-col min-h-0 h-full">
            <div className="px-5 py-4 border-b border-zinc-800 shrink-0">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-zinc-100">{selected.title}</h2>
                <StatusBadge status={selected.status} />
              </div>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {selected.status !== 'active' && selected.status !== 'stopped' && (
                  <button
                    onClick={() => void control(selected, 'resume')}
                    className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-sm text-zinc-300 hover:border-zinc-600"
                  >
                    <Play size={14} /> Resume
                  </button>
                )}
                {selected.status === 'active' && (
                  <button
                    onClick={() => void control(selected, 'pause')}
                    className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-sm text-zinc-300 hover:border-zinc-600"
                  >
                    <Pause size={14} /> Pause
                  </button>
                )}
                {selected.status !== 'stopped' && (
                  <button
                    onClick={() => void control(selected, 'stop')}
                    className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-sm text-zinc-300 hover:border-zinc-600"
                  >
                    <Stop size={14} /> Stop
                  </button>
                )}
                <button
                  onClick={() => void remove(selected)}
                  className="ml-auto flex items-center gap-1 rounded-lg border border-red-500/40 px-2.5 py-1 text-sm text-red-300 hover:border-red-500/60"
                >
                  <Trash size={14} /> Delete
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Run ledger</h3>
              {runs.length === 0 && <p className="text-sm text-zinc-600">No runs recorded yet.</p>}
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-200">#{r.run_number} · {r.status}</span>
                      <span className="text-xs text-zinc-500">{new Date(r.started_at).toLocaleString()}</span>
                    </div>
                    {r.result_summary && <p className="mt-1 text-xs text-zinc-500">{r.result_summary}</p>}
                    {r.error && <p className="mt-1 text-xs text-red-300">{r.error}</p>}
                    {r.stop_reason && <p className="mt-1 text-xs text-amber-300">stopped: {r.stop_reason}</p>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-sm text-zinc-600 text-center">Select a mission</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Mission['status'] }) {
  const color = status === 'active'
    ? 'text-emerald-300 border-emerald-500/40'
    : status === 'paused'
    ? 'text-amber-300 border-amber-500/40'
    : 'text-zinc-400 border-zinc-600/40';
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${color}`}>{status}</span>;
}
