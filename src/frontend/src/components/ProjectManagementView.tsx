/**
 * The initiative level. Monday items for the project's configured scope,
 * grouped the way Monday groups them, each showing the roll-up computed from
 * its linked Nexus tasks.
 *
 * A load failure renders as an error, never as an empty board — "Monday
 * rejected our token" and "this board has no items" must not look alike.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MondayItemWithLinks } from '@nexus/shared';
import { fetchMondayItems, unlinkTaskFromMondayItem, type FetchJsonError } from '../api';

interface Props {
  projectId: string;
}

interface LoadError {
  message: string;
  code?: string;
  /** false = the user must fix something (token/board config), not retry.
   *  true/undefined ("unknown") = safe to offer a Retry button. */
  retryable?: boolean;
}

export function ProjectManagementView({ projectId }: Props) {
  const [items, setItems] = useState<MondayItemWithLinks[] | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Guards against a stale response overwriting newer data (e.g. projectId
  // changes while a request is in flight and the older one resolves last).
  // Each call to `load` stamps itself with the current generation; if a
  // newer call has started by the time this one settles, its result is
  // discarded. A plain per-effect `cancelled` boolean (the ChatPanel.tsx
  // convention) doesn't work here because `load` is also invoked directly
  // from the Retry/Refresh buttons, outside that effect's closure — a
  // monotonic counter covers both call sites correctly.
  const generationRef = useRef(0);

  // Task-scoped, separate from the row-level `error` above: unlinking one
  // task must not be confused with (or clobber) a full load/refresh failure.
  // Use a Set to track multiple concurrent unlinks; a single scalar would break
  // when two unlinks are in flight at once (the first's finally would reset the
  // state while the second is still pending).
  const [unlinkingTaskIds, setUnlinkingTaskIds] = useState<Set<string>>(new Set());
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    const generation = ++generationRef.current;
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      const result = await fetchMondayItems(projectId, refresh);
      if (generationRef.current !== generation) return; // superseded
      setItems(result);
    } catch (err) {
      if (generationRef.current !== generation) return; // superseded
      const e = err as FetchJsonError;
      setError({ message: e.message, code: e.code, retryable: e.retryable });
    } finally {
      if (generationRef.current === generation) setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { void load(false); }, [load]);

  // Unlink a task from an item row, then refresh so the roll-up (and this
  // row's task_ids) reflects the change — no stale state left on screen.
  const handleUnlink = useCallback(async (taskId: string) => {
    setUnlinkingTaskIds(prev => new Set([...prev, taskId]));
    setUnlinkError(null);
    try {
      await unlinkTaskFromMondayItem(taskId);
      await load(false);
    } catch (err) {
      setUnlinkError((err as Error).message);
    } finally {
      setUnlinkingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }, [load]);

  // No data has ever loaded successfully and the load failed — full-screen
  // error. This is the only state that must never look like an empty board.
  if (error && items === null) {
    return (
      <div className="p-6">
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error.message}
        </div>
        {error.retryable === false ? (
          <p className="mt-3 text-sm text-zinc-500">Check your Monday token or board configuration, then try again.</p>
        ) : (
          <button
            type="button"
            className="mt-3 text-sm text-zinc-400 hover:text-zinc-100 underline"
            onClick={() => void load(false)}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (items === null) {
    return <div className="p-6 text-sm text-zinc-600">Loading Monday items…</div>;
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

      {/* A refresh that fails after a successful load must not throw away
          still-valid data — keep the items and surface the error inline. */}
      {error ? (
        <div role="alert" className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{error.message}</span>
          {error.retryable === false ? (
            <span className="text-xs text-red-300/70 shrink-0">Check your Monday token or board configuration.</span>
          ) : (
            <button
              type="button"
              className="text-xs text-red-300 underline shrink-0"
              onClick={() => void load(false)}
            >
              Retry
            </button>
          )}
        </div>
      ) : null}

      {unlinkError ? (
        <div role="alert" className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{unlinkError}</span>
          <button
            type="button"
            className="text-xs text-red-300 underline shrink-0"
            onClick={() => setUnlinkError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        {!error && items.length === 0 ? (
          <div className="text-sm text-zinc-600 text-center py-10">No Monday items in this project&apos;s scope.</div>
        ) : (
          [...groups.entries()].map(([groupTitle, groupItems]) => (
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
                    {item.task_ids.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {item.task_ids.map((taskId) => (
                          <li
                            key={taskId}
                            className="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
                          >
                            <span>{taskId}</span>
                            <button
                              type="button"
                              disabled={unlinkingTaskIds.has(taskId)}
                              onClick={() => void handleUnlink(taskId)}
                              aria-label={`Unlink task ${taskId} from ${item.name}`}
                              className="text-zinc-500 hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {unlinkingTaskIds.has(taskId) ? '…' : '✕'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
