import { useState, useEffect } from 'react';
import { Project } from '@nexus/shared';
import { CaretDown } from '@phosphor-icons/react';

interface TriageToProjectProps {
  projects: Project[];
  /** Create a task in the chosen project; resolves when done. */
  onCreate: (projectId: string) => Promise<void>;
  /** Reset the success/error message — bump this key when the selected source item changes. */
  resetKey?: string;
}

export default function TriageToProject({ projects, onCreate, resetKey }: TriageToProjectProps) {
  const [targetProject, setTargetProject] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!targetProject && projects.length > 0) setTargetProject(projects[0].id);
  }, [projects, targetProject]);

  useEffect(() => { setMsg(null); }, [resetKey]);

  const selectedProject = projects.find(p => p.id === targetProject) ?? projects[0];

  const selectProject = (projectId: string) => {
    setTargetProject(projectId);
    setPickerOpen(false);
  };

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
          <div className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-label={`Target project ${selectedProject?.name ?? 'none'}`}
              onClick={() => setPickerOpen(open => !open)}
              className="triage-project-trigger"
            >
              <span className="min-w-0 truncate">{selectedProject?.name ?? 'Choose project'}</span>
              <CaretDown
                size={16}
                className={`shrink-0 text-muted transition-transform ${pickerOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {pickerOpen && (
              <div
                role="listbox"
                aria-label="Target project"
                className="triage-project-listbox"
              >
                {projects.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === targetProject}
                    onClick={() => selectProject(p.id)}
                    className={`triage-project-option ${p.id === targetProject ? 'triage-project-option-selected' : ''}`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full px-3 py-2 text-sm accent-button rounded-md disabled:opacity-40 transition-colors"
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
