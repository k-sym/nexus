import { useState, useEffect } from 'react';
import { Project, Persona, TaskStatus, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, ProjectConfig } from '@nexus/shared';
import { api } from '../api';

interface ColumnAgentMappingProps {
  project: Project;
  onUpdate: (project: Project) => void;
}

export default function ColumnAgentMapping({ project, onUpdate }: ColumnAgentMappingProps) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [columnDefaults, setColumnDefaults] = useState<Record<TaskStatus, string | null>>(() => {
    try {
      const parsed = JSON.parse(project.config_json) as ProjectConfig;
      if (parsed.column_defaults) return parsed.column_defaults;
    } catch { /* ignore */ }
    const empty: Record<TaskStatus, string | null> = { triage: null, todo: null, in_progress: null, review: null, deploy: null };
    return empty;
  });

  useEffect(() => {
    api.personas.list().then(setPersonas).catch(console.error);
  }, []);

  const handleColumnChange = async (column: TaskStatus, agentSlug: string | null) => {
    const updated = { ...columnDefaults, [column]: agentSlug || null };
    setColumnDefaults(updated);

    const config: ProjectConfig = { column_defaults: updated };
    try {
      const saved = await api.projects.update(project.id, {
        config_json: JSON.stringify(config),
      });
      onUpdate(saved);
    } catch (err) {
      console.error('Failed to update project config:', err);
    }
  };

  return (
    <div className="space-y-2">
      {KANBAN_COLUMNS.map(column => (
        <div key={column} className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 w-24 shrink-0">{KANBAN_COLUMN_LABELS[column]}</span>
          <select
            value={columnDefaults[column] || ''}
            onChange={e => handleColumnChange(column, e.target.value || null)}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500/50"
          >
            <option value="">— Auto —</option>
            {personas.map(p => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
