/**
 * The initiative level. Monday items for the project's configured scope,
 * grouped the way Monday groups them, each showing the roll-up computed from
 * its linked Nexus tasks.
 *
 * A load failure renders as an error, never as an empty board — "Monday
 * rejected our token" and "this board has no items" must not look alike.
 */
import { useCallback, useEffect, useState } from 'react';
import type { MondayItemWithLinks } from '@nexus/shared';
import { fetchMondayItems } from '../api';

interface Props {
  projectId: string;
}

export function ProjectManagementView({ projectId }: Props) {
  const [items, setItems] = useState<MondayItemWithLinks[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      setItems(await fetchMondayItems(projectId, refresh));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { void load(false); }, [load]);

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
        <button
          type="button"
          className="mt-3 text-sm text-zinc-400 hover:text-zinc-100 underline"
          onClick={() => void load(false)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (items === null) {
    return <div className="p-6 text-sm text-zinc-600">Loading Monday items…</div>;
  }

  if (items.length === 0) {
    return <div className="p-6 text-sm text-zinc-600 text-center py-10">No Monday items in this project&apos;s scope.</div>;
  }

  const groups = new Map<string, MondayItemWithLinks[]>();
  for (const item of items) {
    const key = item.group_title ?? 'Ungrouped';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
        <div>
          <h1 className="text-xl font-semibold">Project Management</h1>
          <p className="text-xs text-zinc-500">Monday.com initiatives in this project&apos;s scope, with roll-up from linked tasks.</p>
        </div>
        <button
          type="button"
          disabled={refreshing}
          className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void load(true)}
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh from Monday'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        {[...groups.entries()].map(([groupTitle, groupItems]) => (
          <div key={groupTitle}>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-2">
              {groupTitle}
            </div>
            <ul className="space-y-1.5">
              {groupItems.map((item) => (
                <li key={item.item_id} className="bg-zinc-900 border border-zinc-800 rounded-md px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-zinc-200">{item.name}</span>
                    <span className="text-sm text-zinc-400 shrink-0">{item.rollup_text}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500">
                    {item.status_label ? <span>{item.status_label}</span> : null}
                    <span>{item.task_ids.length} linked task{item.task_ids.length === 1 ? '' : 's'}</span>
                    {item.state === 'missing' ? (
                      <span className="text-amber-300">item unavailable in Monday</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
