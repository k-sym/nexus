import { useState, useEffect, useCallback } from 'react';
import { Brain, Trash } from '@phosphor-icons/react';
import { Project, BraindumpIdea } from '@nexus/shared';
import { api } from '../api';
import TriageToProject from './TriageToProject';

interface BraindumpViewProps {
  projects: Project[];
  /** Create a task in the chosen project from an idea; resolves to the created task id. */
  onTriage: (projectId: string, idea: BraindumpIdea) => Promise<string>;
}

export default function BraindumpView({ projects, onTriage }: BraindumpViewProps) {
  const [ideas, setIdeas] = useState<BraindumpIdea[]>([]);
  const [selected, setSelected] = useState<BraindumpIdea | null>(null);
  const [draft, setDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.braindump.list();
      setIdeas(data);
      setSelected(prev => (prev ? data.find(i => i.id === prev.id) ?? null : null));
    } catch (err) {
      console.error('Failed to load ideas:', err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setBodyDraft(selected?.body ?? ''); }, [selected]);

  const handleAdd = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    const idea = await api.braindump.create({ title });
    await load();
    setSelected(idea);
  };

  const handleSaveBody = async () => {
    if (!selected || bodyDraft === selected.body) return;
    const updated = await api.braindump.update(selected.id, { body: bodyDraft });
    setSelected(updated);
    setIdeas(prev => prev.map(i => (i.id === updated.id ? updated : i)));
  };

  const handleDelete = async (id: string) => {
    await api.braindump.delete(id);
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const handleTriage = async (projectId: string) => {
    if (!selected) return;
    const taskId = await onTriage(projectId, selected);
    await api.braindump.update(selected.id, { status: 'triaged', project_id: projectId, task_id: taskId });
    setSelected(null);
    await load();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex min-h-0 flex-1">
        {/* List + quick add */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="px-6 py-4 border-b border-zinc-800 shrink-0">
            <h1 className="text-xl font-semibold flex items-center gap-2"><Brain size={22} weight="fill" /> Braindump</h1>
            <p className="text-xs text-zinc-500">Capture ideas, then triage them into a project ({ideas.length}).</p>
          </header>

          <div className="px-6 py-3 border-b border-zinc-800/60 shrink-0">
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="Capture an idea and press Enter…"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-strong"
            />
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5">
            {ideas.length === 0 && (
              <div className="text-sm text-zinc-600 text-center py-10">No ideas yet. Capture one above.</div>
            )}
            {ideas.map(idea => (
              <button
                key={idea.id}
                onClick={() => setSelected(idea)}
                className={`group w-full text-left bg-zinc-900 border rounded-md px-4 py-2.5 transition-colors ${
                  selected?.id === idea.id ? 'border-strong' : 'border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-200 truncate flex-1">{idea.title}</span>
                  <Trash
                    size={14}
                    className="text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
                    onClick={(e) => { e.stopPropagation(); handleDelete(idea.id); }}
                  />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="w-96 border-l border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0 overflow-y-auto">
          {selected ? (
            <div className="p-5 space-y-4">
              <h2 className="text-base font-semibold text-zinc-100 leading-snug">{selected.title}</h2>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-1">Notes</div>
                <textarea
                  value={bodyDraft}
                  onChange={e => setBodyDraft(e.target.value)}
                  onBlur={handleSaveBody}
                  rows={6}
                  placeholder="Flesh out the idea…"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-strong resize-none"
                />
              </div>
              <TriageToProject projects={projects} resetKey={selected.id} onCreate={handleTriage} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-sm text-zinc-600 text-center">Select an idea to flesh it out and triage it into a project.</p>
            </div>
          )}
        </div>
      </div>

      {/* Full-width body preview */}
      {selected && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 shrink-0 max-h-[40%] overflow-y-auto px-6 py-4">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-2">Preview</div>
          {bodyDraft.trim()
            ? <p className="whitespace-pre-wrap text-sm text-zinc-300 leading-relaxed">{bodyDraft}</p>
            : <p className="text-sm text-zinc-600">Add notes to see them previewed here.</p>}
        </div>
      )}
    </div>
  );
}
