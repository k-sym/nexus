import { useState, useCallback } from 'react';
import { api } from '../api';

interface MemorySearchProps {
  projectId: string;
}

const CATEGORIES = ['general', 'decision', 'chat', 'agent_run', 'specs'];

export default function MemorySearch({ projectId }: MemorySearchProps) {
  const [query, setQuery] = useState('');
  const [memories, setMemories] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [newMemory, setNewMemory] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [adding, setAdding] = useState(false);

  const handleSearch = useCallback(async () => {
    setSearching(true);
    try {
      const results = api.memory.search(projectId, query);
      setMemories(await results);
    } catch {
      setMemories([]);
    } finally {
      setSearching(false);
    }
  }, [projectId, query]);

  const handleAdd = async () => {
    if (!newMemory.trim()) return;
    setAdding(true);
    try {
      await api.memory.create(projectId, { content: newMemory.trim(), category: newCategory });
      setNewMemory('');
      if (query) handleSearch();
    } catch (err) {
      console.error('Failed to add memory:', err);
    } finally {
      setAdding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && query.trim()) handleSearch();
  };

  return (
    <div className="w-60 border-l border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0">
      <div className="p-3 border-b border-zinc-800">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Memory</h3>
        <div className="flex gap-1">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search memories..."
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="px-2 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 disabled:opacity-40 transition-colors"
          >
            {searching ? '...' : '→'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {memories.map((mem, i) => (
          <div key={i} className="bg-zinc-800/50 rounded px-2.5 py-1.5 text-xs text-zinc-400 leading-relaxed">
            {mem}
          </div>
        ))}

        {memories.length === 0 && query && !searching && (
          <div className="text-xs text-zinc-600 text-center py-2">No memories found</div>
        )}

        {!query && (
          <div className="text-xs text-zinc-600 text-center py-2">Search or add memories</div>
        )}
      </div>

      <div className="border-t border-zinc-800 p-2 space-y-1.5">
        <select
          value={newCategory}
          onChange={e => setNewCategory(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none"
        >
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <textarea
          value={newMemory}
          onChange={e => setNewMemory(e.target.value)}
          placeholder="Add a memory..."
          rows={2}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-indigo-500/50 font-mono"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newMemory.trim()}
          className="w-full px-2 py-1 text-xs bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-40 transition-colors"
        >
          {adding ? 'Adding...' : 'Add Memory'}
        </button>
      </div>
    </div>
  );
}
