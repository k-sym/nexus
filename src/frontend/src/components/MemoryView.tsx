import { useState, useEffect, useCallback } from 'react';
import { Copy, Eye, PencilSimple, Trash, X } from '@phosphor-icons/react';
import { api, type MemoryRecord } from '../api';

interface MemoryViewProps {
  projectId: string;
}

const CATEGORIES = ['general', 'decision', 'chat', 'agent_run', 'specs'];

function displayTitle(memory: MemoryRecord): string {
  return memory.title || memory.content.slice(0, 80) || 'Untitled memory';
}

function shortDate(value: string): string {
  return value ? value.slice(0, 10) : '';
}

interface MemoryArticleProps {
  memory: MemoryRecord;
  selected: boolean;
  onView: (memory: MemoryRecord) => void;
  onCopy: (memory: MemoryRecord) => void;
  onEdit: (memory: MemoryRecord) => void;
  onDelete: (memory: MemoryRecord) => void;
}

function MemoryArticle({ memory, selected, onView, onCopy, onEdit, onDelete }: MemoryArticleProps) {
  return (
    <article
      className={`bg-zinc-900 border rounded-md px-4 py-3 transition-colors ${
        selected ? 'border-indigo-500/60' : 'border-zinc-800 hover:border-zinc-700'
      }`}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onView(memory)}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-indigo-400/80">{memory.category}</span>
            {memory.updated_at && <span className="text-[10px] text-zinc-600">{shortDate(memory.updated_at)}</span>}
            {memory.source && <span className="text-[10px] text-zinc-600">{memory.source}</span>}
          </div>
          <div className="text-sm font-medium text-zinc-200 break-words">{displayTitle(memory)}</div>
          <p className="mt-1 text-sm text-zinc-400 leading-relaxed break-words line-clamp-3">{memory.content}</p>
        </button>
        <div className="shrink-0 flex items-center gap-1">
          <button
            type="button"
            onClick={() => onView(memory)}
            aria-label="View memory"
            title="View memory"
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Eye size={15} />
          </button>
          <button
            type="button"
            onClick={() => onCopy(memory)}
            aria-label="Copy memory"
            title="Copy memory"
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Copy size={15} />
          </button>
          <button
            type="button"
            onClick={() => onEdit(memory)}
            aria-label="Edit memory"
            title="Edit memory"
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <PencilSimple size={15} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(memory)}
            aria-label="Delete memory"
            title="Delete memory"
            className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            <Trash size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}

export default function MemoryView({ projectId }: MemoryViewProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryRecord[] | null>(null);
  const [recent, setRecent] = useState<MemoryRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [newMemory, setNewMemory] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<MemoryRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  const loadRecent = useCallback(async () => {
    try {
      const rows = await api.memory.list(projectId);
      setRecent(rows);
      setSelected(current => current ? rows.find(row => row.id === current.id) ?? current : current);
    } catch {
      setRecent([]);
    }
  }, [projectId]);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const rows = await api.memory.search(projectId, query.trim());
      setResults(rows);
      setSelected(current => current ? rows.find(row => row.id === current.id) ?? current : current);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [projectId, query]);

  const refreshCurrentView = useCallback(async () => {
    if (results !== null && query.trim()) await handleSearch();
    await loadRecent();
  }, [handleSearch, loadRecent, query, results]);

  useEffect(() => {
    setQuery('');
    setResults(null);
    setSelected(null);
    setEditing(false);
    loadRecent();
  }, [projectId, loadRecent]);

  const handleAdd = async () => {
    if (!newMemory.trim()) return;
    setAdding(true);
    try {
      await api.memory.create(projectId, { content: newMemory.trim(), category: newCategory });
      setNewMemory('');
      await refreshCurrentView();
    } catch (err) {
      console.error('Failed to add memory:', err);
    } finally {
      setAdding(false);
    }
  };

  const handleView = (memory: MemoryRecord) => {
    setSelected(memory);
    setEditing(false);
    setEditContent(memory.content);
  };

  const handleEdit = (memory: MemoryRecord) => {
    setSelected(memory);
    setEditing(true);
    setEditContent(memory.content);
  };

  const handleCopy = async (memory: MemoryRecord) => {
    try {
      await navigator.clipboard.writeText(memory.content);
      setCopyMessage('Copied');
    } catch {
      setCopyMessage('Copy failed');
    }
  };

  const handleSave = async () => {
    if (!selected || !editContent.trim()) return;
    setSaving(true);
    try {
      await api.memory.update(selected.id, { content: editContent.trim() });
      const updated = { ...selected, content: editContent.trim() };
      setSelected(updated);
      setEditing(false);
      await refreshCurrentView();
    } catch (err) {
      console.error('Failed to update memory:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (memory: MemoryRecord) => {
    if (!window.confirm('Delete this memory permanently?')) return;
    try {
      await api.memory.delete(memory.id);
      if (selected?.id === memory.id) {
        setSelected(null);
        setEditing(false);
      }
      await refreshCurrentView();
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const rows = results !== null ? results : recent;
  const heading = results !== null ? 'Search results' : `Recent (${recent.length})`;

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search memories..."
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          <button
            type="button"
            onClick={handleSearch}
            disabled={searching}
            className="px-4 py-2 text-sm bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors cursor-pointer"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
          {results !== null && (
            <button
              type="button"
              onClick={() => { setQuery(''); setResults(null); }}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-5xl mx-auto grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
          <section className="min-w-0 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-1">
              {heading}
            </div>
            {rows.length === 0 && !searching && (
              <div className="text-sm text-zinc-600 text-center py-8">
                {results !== null ? `No memories found for "${query}".` : 'No memories yet for this project. Add one below, or let agents capture them.'}
              </div>
            )}
            {rows.map(memory => (
              <MemoryArticle
                key={memory.id}
                memory={memory}
                selected={selected?.id === memory.id}
                onView={handleView}
                onCopy={handleCopy}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </section>

          <aside className="border border-zinc-800 bg-zinc-950 rounded-md min-h-[260px]">
            {selected ? (
              <div className="p-4 space-y-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-wider text-indigo-400/80">{selected.category}</div>
                    <h2 className="text-base font-semibold text-zinc-100 break-words">{displayTitle(selected)}</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setSelected(null); setEditing(false); }}
                    aria-label="Close memory detail"
                    className="p-1.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <X size={15} />
                  </button>
                </div>

                <div className="space-y-1 text-xs text-zinc-500">
                  <p>Source: {selected.source || 'unknown'}</p>
                  <p>Created: {shortDate(selected.created_at)}</p>
                  <p>Updated: {shortDate(selected.updated_at)}</p>
                </div>

                {editing ? (
                  <div className="space-y-2">
                    <label className="block text-xs text-zinc-400" htmlFor="memory-content-editor">Memory content</label>
                    <textarea
                      id="memory-content-editor"
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      rows={8}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 resize-y focus:outline-none focus:border-indigo-500/50"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || !editContent.trim()}
                        className="px-3 py-1.5 text-xs bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        {saving ? 'Saving...' : 'Save memory'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditing(false); setEditContent(selected.content); }}
                        className="px-3 py-1.5 text-xs border border-zinc-800 text-zinc-300 rounded-md hover:bg-zinc-900 transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">{selected.content}</p>
                )}

                <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => handleCopy(selected)}
                    className="px-3 py-1.5 text-xs border border-zinc-800 text-zinc-300 rounded-md hover:bg-zinc-900 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <Copy size={13} /> Copy memory
                  </button>
                  <button
                    type="button"
                    onClick={() => handleEdit(selected)}
                    aria-label="Edit selected memory"
                    className="px-3 py-1.5 text-xs border border-zinc-800 text-zinc-300 rounded-md hover:bg-zinc-900 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <PencilSimple size={13} /> Edit memory
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(selected)}
                    aria-label="Delete selected memory"
                    className="px-3 py-1.5 text-xs border border-red-500/40 text-red-300 rounded-md hover:bg-red-500/10 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <Trash size={13} /> Delete memory
                  </button>
                </div>
                {copyMessage && <p className="text-xs text-zinc-500">{copyMessage}</p>}
              </div>
            ) : (
              <div className="p-4 text-sm text-zinc-600">
                Select a memory to view full content and metadata.
              </div>
            )}
          </aside>
        </div>
      </div>

      <div className="border-t border-zinc-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex gap-2 items-end">
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
            placeholder="Add a memory..."
            rows={1}
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-indigo-500/50"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={adding || !newMemory.trim()}
            className="px-4 py-2 text-sm bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors cursor-pointer"
          >
            {adding ? 'Adding...' : 'Add Memory'}
          </button>
        </div>
      </div>
    </div>
  );
}
