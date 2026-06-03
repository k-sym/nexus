import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

interface MemoryViewProps {
  projectId: string;
}

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  created_at: string;
}

const CATEGORIES = ['general', 'decision', 'chat', 'agent_run', 'specs'];

export default function MemoryView({ projectId }: MemoryViewProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[] | null>(null); // null = showing recent, not a search
  const [recent, setRecent] = useState<MemoryRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [newMemory, setNewMemory] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [adding, setAdding] = useState(false);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(await api.memory.list(projectId));
    } catch {
      setRecent([]);
    }
  }, [projectId]);

  useEffect(() => {
    setQuery('');
    setResults(null);
    loadRecent();
  }, [projectId, loadRecent]);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      setResults(await api.memory.search(projectId, query));
    } catch {
      setResults([]);
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
      if (results !== null && query) await handleSearch();
      await loadRecent();
    } catch (err) {
      console.error('Failed to add memory:', err);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.memory.delete(id);
      await loadRecent();
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search memories…"
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="px-4 py-2 text-sm bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
          {results !== null && (
            <button
              onClick={() => { setQuery(''); setResults(null); }}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Results / recent */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-2">
          {results !== null ? (
            <>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-1">
                Search results
              </div>
              {results.length === 0 && !searching && (
                <div className="text-sm text-zinc-600 text-center py-8">No memories found for “{query}”.</div>
              )}
              {results.map((mem, i) => (
                <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-md px-4 py-3 text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {mem}
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-1">
                Recent ({recent.length})
              </div>
              {recent.length === 0 && (
                <div className="text-sm text-zinc-600 text-center py-8">
                  No memories yet for this project. Add one below, or let agents capture them.
                </div>
              )}
              {recent.map(m => (
                <div key={m.id} className="group bg-zinc-900 border border-zinc-800 rounded-md px-4 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] uppercase tracking-wider text-indigo-400/80">{m.category}</span>
                      {m.created_at && <span className="text-[10px] text-zinc-600">{m.created_at.slice(0, 10)}</span>}
                    </div>
                    <p className="text-sm text-zinc-300 leading-relaxed break-words">{m.content}</p>
                  </div>
                  <button
                    onClick={() => handleDelete(m.id)}
                    title="Delete memory"
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-opacity shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Add */}
      <div className="border-t border-zinc-800 px-6 py-4">
        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          <select
            value={newCategory}
            onChange={e => setNewCategory(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-md px-2 py-2 text-sm text-zinc-200 focus:outline-none"
          >
            {CATEGORIES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <textarea
            value={newMemory}
            onChange={e => setNewMemory(e.target.value)}
            placeholder="Add a memory…"
            rows={1}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-indigo-500/50"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !newMemory.trim()}
            className="px-4 py-2 text-sm bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {adding ? 'Adding…' : 'Add Memory'}
          </button>
        </div>
      </div>
    </div>
  );
}
