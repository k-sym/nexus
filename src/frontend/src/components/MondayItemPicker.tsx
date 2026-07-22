/**
 * Link a task to a Monday item. Reachable from both ends — an item row in the
 * Project Management view and the task modal on Kanban — so this component is
 * shared rather than duplicated.
 *
 * Search hits Monday live rather than the mirror, so an item created moments
 * ago is findable.
 */
import { useEffect, useState } from 'react';
import type { MondayItem } from '@nexus/shared';
import { searchMondayItems, linkTaskToMondayItem, unlinkTaskFromMondayItem } from '../api';

interface Props {
  projectId: string;
  taskId: string;
  currentItemId: string | null;
  onLinked: () => void;
}

export function MondayItemPicker({ projectId, taskId, currentItemId, onLinked }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MondayItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setError(null);
      try {
        const items = await searchMondayItems(projectId, query.trim());
        if (!cancelled) setResults(items);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [projectId, query]);

  async function link(itemId: string) {
    setBusy(true);
    setError(null);
    try {
      await linkTaskToMondayItem(projectId, taskId, itemId);
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await unlinkTaskFromMondayItem(taskId);
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        placeholder="Search Monday initiatives…"
        onChange={(event) => setQuery(event.target.value)}
        className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
      />
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {currentItemId ? (
        <button type="button" disabled={busy} onClick={() => void unlink()} className="text-sm underline">
          Unlink from Monday
        </button>
      ) : null}
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {results.map((item) => (
          <li key={item.item_id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void link(item.item_id)}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-white/5"
            >
              {item.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
