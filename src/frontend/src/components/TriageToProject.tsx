import { useState, useEffect } from 'react';
import { Project } from '@nexus/shared';

interface TriageToProjectProps {
  projects: Project[];
  /** Create a task in the chosen project; resolves when done. */
  onCreate: (projectId: string) => Promise<void>;
  /** Reset the success/error message — bump this key when the selected source item changes. */
  resetKey?: string;
}

export default function TriageToProject({ projects, onCreate, resetKey }: TriageToProjectProps) {
  const [targetProject, setTargetProject] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!targetProject && projects.length > 0) setTargetProject(projects[0].id);
  }, [projects, targetProject]);

  useEffect(() => { setMsg(null); }, [resetKey]);

  const handleCreate = async () => {
    if (!targetProject) return;
    setCreating(true);
    setMsg(null);
    try {
      await onCreate(targetProject);
      const name = projects.find(p => p.id === targetProject)?.name ?? 'project';
      setMsg(`Created in ${name}`);
    } catch (err) {
      console.error('Failed to create task:', err);
      setMsg('Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Triage → create task</div>
      {projects.length === 0 ? (
        <p className="text-xs text-zinc-600">Create a project first to triage this into a Kanban task.</p>
      ) : (
        <>
          <select
            value={targetProject}
            onChange={e => setTargetProject(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-2 text-sm text-zinc-200 focus:outline-none"
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full px-3 py-2 text-sm bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {creating ? 'Creating…' : 'Create task'}
          </button>
          {msg && (
            <p className={`text-xs text-center ${msg.startsWith('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>{msg}</p>
          )}
        </>
      )}
    </div>
  );
}
