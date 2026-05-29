import { useState, useEffect, useCallback } from 'react';
import { Persona } from '@nexus/shared';
import { api } from '../api';
import PersonaCard from './PersonaCard';
import PersonaEditor from './PersonaEditor';

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [showEditor, setShowEditor] = useState(false);

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

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Personas</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Define agent personalities that can be assigned to tasks and conversations</p>
        </div>
        <button
          onClick={() => setShowEditor(true)}
          className="px-4 py-2 bg-indigo-500 text-white text-sm rounded-lg hover:bg-indigo-500 transition-colors"
        >
          + New Persona
        </button>
      </div>

      <div className="space-y-3">
        {personas.map(persona => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            onDelete={handleDelete}
            onRefresh={loadPersonas}
          />
        ))}

        {personas.length === 0 && (
          <div className="text-center py-12">
            <p className="text-zinc-500 text-sm mb-2">No personas defined</p>
            <button
              onClick={() => setShowEditor(true)}
              className="text-indigo-500 text-sm hover:underline"
            >
              Create your first persona
            </button>
          </div>
        )}
      </div>

      {showEditor && (
        <PersonaEditor
          onClose={() => setShowEditor(false)}
          onCreated={(persona) => {
            setShowEditor(false);
            loadPersonas();
          }}
        />
      )}
    </div>
  );
}
