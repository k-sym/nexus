import { useState, useEffect, useCallback } from 'react';
import { Persona, PersonaConfig } from '@nexus/shared';
import { api } from '../api';
import PersonaCard from './PersonaCard';
import PersonaEditor from './PersonaEditor';

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editing, setEditing] = useState<PersonaConfig | undefined>(undefined);

  const loadPersonas = useCallback(async () => {
    try {
      const data = await api.personas.list();
      setPersonas(data);
    } catch (err) {
      console.error('Failed to load personas:', err);
    }
  }, []);

  useEffect(() => {
    loadPersonas();
  }, [loadPersonas]);

  const handleDelete = async (slug: string) => {
    try {
      await api.personas.delete(slug);
      await loadPersonas();
    } catch (err) {
      console.error('Failed to delete persona:', err);
    }
  };

  const handleEdit = async (slug: string) => {
    try {
      const config = await api.personas.get(slug);
      setEditing(config);
      setShowEditor(true);
    } catch (err) {
      console.error('Failed to load persona for edit:', err);
    }
  };

  const openNew = () => { setEditing(undefined); setShowEditor(true); };
  const closeEditor = () => { setShowEditor(false); setEditing(undefined); };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Define agent personalities that can be assigned to tasks and conversations</p>
        </div>
        <button
          onClick={openNew}
          className="shrink-0 px-4 py-2 bg-indigo-500 text-white text-sm rounded-lg hover:bg-indigo-600 transition-colors"
        >
          + New Agent
        </button>
      </div>

      <div className="space-y-3">
        {personas.map(persona => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            onDelete={handleDelete}
            onEdit={handleEdit}
            onRefresh={loadPersonas}
          />
        ))}

        {personas.length === 0 && (
          <div className="text-center py-12">
            <p className="text-zinc-500 text-sm mb-2">No agents defined</p>
            <button
              onClick={openNew}
              className="text-indigo-500 text-sm hover:underline"
            >
              Create your first agent
            </button>
          </div>
        )}
      </div>

      {showEditor && (
        <PersonaEditor
          initial={editing}
          onClose={closeEditor}
          onCreated={() => {
            closeEditor();
            loadPersonas();
          }}
        />
      )}
    </div>
  );
}
