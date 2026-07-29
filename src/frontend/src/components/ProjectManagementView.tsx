/**
 * The initiative level. Monday items for the project's configured scope,
 * grouped the way Monday groups them, each showing the roll-up computed from
 * its linked Nexus tasks.
 *
 * A load failure renders as an error, never as an empty board — "Monday
 * rejected our token" and "this board has no items" must not look alike.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MondayItemWithLinks, MondayProjectConfig, Task } from '@nexus/shared';
import {
  api, fetchMondayItems, fetchMondayProjectConfig, linkTaskToMondayItem, unlinkTaskFromMondayItem,
  type FetchJsonError,
} from '../api';
import { MondayScopeSettings } from './MondayScopeSettings';

interface Props {
  projectId: string;
  /** Jump to this project's Kanban board — used by the linked-task chips so a
   *  task can be found where it lives. Optional so the component still renders
   *  standalone (e.g. in tests); the chip is a plain label without it. */
  onNavigateToKanban?: () => void;
}

/** The Monday board's own URL, derived from any mirrored item's `url` (which
 *  carries the account subdomain that `board_id` alone lacks). Null when no
 *  item has a url to derive it from. */
function deriveBoardUrl(items: MondayItemWithLinks[]): string | null {
  const withUrl = items.find((i) => i.url);
  if (!withUrl?.url) return null;
  try {
    return `${new URL(withUrl.url).origin}/boards/${withUrl.board_id}`;
  } catch {
    return null;
  }
}

/** A friendly chip label: the task title, or a shortened id when the title
 *  isn't loaded yet (short ids like test fixtures are left intact). */
function chipLabel(taskId: string, task: Task | undefined): string {
  if (task?.title) return task.title;
  return taskId.length > 12 ? `${taskId.slice(0, 8)}…` : taskId;
}

/** Any non-'active' state means the initiative should not read as healthy in
 *  the row — an archived or deleted item is just as stale/misleading to
 *  present as a missing one, so all three degrade the same way here, worded
 *  for the state (mirrors MondayBadge.tsx's Kanban-card equivalent). */
function degradedLabel(state: MondayItemWithLinks['state']): string | null {
  switch (state) {
    case 'missing': return 'item unavailable in Monday';
    case 'archived': return 'item archived in Monday';
    case 'deleted': return 'item deleted in Monday';
    default: return null;
  }
}

interface LoadError {
  message: string;
  code?: string;
  /** false = the user must fix something (token/board config), not retry.
   *  true/undefined ("unknown") = safe to offer a Retry button. */
  retryable?: boolean;
}

export function ProjectManagementView({ projectId, onNavigateToKanban }: Props) {
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

  // Item-scoped, same shape as the unlink state: a Set so two concurrent
  // "create task in Triage" clicks on different rows don't clobber each other.
  const [creatingItemIds, setCreatingItemIds] = useState<Set<string>>(new Set());
  const [createError, setCreateError] = useState<string | null>(null);

  // Linked-task id → task, so a chip can show the task's title instead of its
  // raw UUID. Best-effort: a chip falls back to the id if this hasn't loaded.
  const [tasksById, setTasksById] = useState<Map<string, Task>>(new Map());

  // Not-yet-configured (backend 409 `code: 'unconfigured'`) and "reopened via
  // the header's Configure control" both render the same setup panel, keyed
  // off the config it should pre-fill from: null for the former (there is
  // nothing to pre-fill), the fetched MondayProjectConfig for the latter.
  const [configPanel, setConfigPanel] = useState<{ current: MondayProjectConfig | null } | null>(null);
  const [configOpenError, setConfigOpenError] = useState<string | null>(null);

  // Best-effort task-title lookup for the linked-task chips. Kept separate from
  // the item load: a titles failure must never blank the item list, so it
  // swallows its error and simply leaves the chips on their id fallback.
  const loadTasks = useCallback(async () => {
    try {
      const tasks = await api.projects.tasks(projectId);
      setTasksById(new Map(tasks.map((t) => [t.id, t])));
    } catch {
      // Ignore — chips fall back to the raw id.
    }
  }, [projectId]);

  const load = useCallback(async (refresh: boolean) => {
    void loadTasks();
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
      // The backend distinguishes "no scope configured yet" from every other
      // failure (disabled Monday, expired token, rate limit, ...) via this
      // code, specifically so the setup panel — not the error screen — is
      // the response to the one case that's actually fixable here.
      if (e.code === 'unconfigured') {
        setConfigPanel({ current: null });
        return;
      }
      setError({ message: e.message, code: e.code, retryable: e.retryable });
    } finally {
      if (generationRef.current === generation) setRefreshing(false);
    }
  }, [projectId, loadTasks]);

  // Fetches the project's current Monday scope and opens the setup panel
  // pre-filled with it — the header's Configure control. A failure here
  // surfaces inline rather than opening the panel with a silently-blank
  // (and therefore misleading, given a config does exist) state.
  const openConfig = useCallback(async () => {
    setConfigOpenError(null);
    try {
      const current = await fetchMondayProjectConfig(projectId);
      setConfigPanel({ current });
    } catch (err) {
      setConfigOpenError((err as FetchJsonError).message);
    }
  }, [projectId]);

  const handleConfigSaved = useCallback(() => {
    setConfigPanel(null);
    void load(true);
  }, [load]);

  // Opening the view syncs from Monday, same as the manual Refresh button —
  // the mirror-only read (`load(false)`) is reserved for internal reloads
  // that don't need a fresh scope sync (e.g. after an unlink). Without this,
  // the very first open of a correctly-configured project reads a mirror
  // that scope sync has never populated, and "No Monday items in this
  // project's scope" is indistinguishable from a genuinely empty board.
  useEffect(() => { void load(true); }, [load]);

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

  // Create a Triage task from an item and link it in one click, then reload so
  // the new link (and, when status sync is on, the "Planned" push it triggers)
  // is reflected. The two existing endpoints are reused — no bespoke backend.
  const handleCreateTask = useCallback(async (item: MondayItemWithLinks) => {
    setCreatingItemIds(prev => new Set([...prev, item.item_id]));
    setCreateError(null);
    try {
      const task = await api.projects.createTask(projectId, { title: item.name, status: 'triage' });
      await linkTaskToMondayItem(projectId, task.id, item.item_id);
      await load(false);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreatingItemIds(prev => {
        const next = new Set(prev);
        next.delete(item.item_id);
        return next;
      });
    }
  }, [projectId, load]);

  // Rendered both for a genuinely unconfigured project (no already-loaded
  // view exists, so no Cancel) and for a reopened Configure (items !== null,
  // so Cancel returns to it) — checked before the error/loading branches
  // below so an unconfigured 409 never reaches the error screen.
  if (configPanel) {
    return (
      <div className="p-6">
        <MondayScopeSettings
          projectId={projectId}
          current={configPanel.current}
          onSaved={handleConfigSaved}
          onCancel={items !== null ? () => setConfigPanel(null) : undefined}
        />
      </div>
    );
  }

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

  const boardUrl = deriveBoardUrl(items);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
        <div>
          <h1 className="text-xl font-semibold">Project Management</h1>
          <p className="text-xs text-zinc-500">Monday.com initiatives in this project&apos;s scope, with roll-up from linked tasks.</p>
        </div>
        <div className="flex items-center gap-2">
          {boardUrl ? (
            <a
              href={boardUrl}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors"
            >
              Open board in Monday ↗
            </a>
          ) : null}
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors"
            onClick={() => void openConfig()}
          >
            Configure
          </button>
          <button
            type="button"
            disabled={refreshing}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void load(true)}
          >
            {refreshing ? 'Refreshing…' : '↻ Refresh from Monday'}
          </button>
        </div>
      </header>

      {configOpenError ? (
        <div role="alert" className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{configOpenError}</span>
          <button
            type="button"
            className="text-xs text-red-300 underline shrink-0"
            onClick={() => setConfigOpenError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

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

      {createError ? (
        <div role="alert" className="mx-6 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{createError}</span>
          <button
            type="button"
            className="text-xs text-red-300 underline shrink-0"
            onClick={() => setCreateError(null)}
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
                      {degradedLabel(item.state) ? (
                        <span className="text-amber-300">{degradedLabel(item.state)}</span>
                      ) : null}
                      <button
                        type="button"
                        disabled={creatingItemIds.has(item.item_id) || item.state !== 'active'}
                        onClick={() => void handleCreateTask(item)}
                        aria-label={`Create a Triage task from ${item.name}`}
                        className="ml-auto shrink-0 text-zinc-400 hover:text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {creatingItemIds.has(item.item_id) ? 'Creating…' : '＋ Create task in Triage'}
                      </button>
                    </div>
                    {item.task_ids.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {item.task_ids.map((taskId) => {
                          const label = chipLabel(taskId, tasksById.get(taskId));
                          return (
                            <li
                              key={taskId}
                              className="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
                            >
                              {onNavigateToKanban ? (
                                <button
                                  type="button"
                                  onClick={onNavigateToKanban}
                                  title="Open on the Kanban board"
                                  className="max-w-[16rem] truncate text-left hover:text-zinc-100"
                                >
                                  {label}
                                </button>
                              ) : (
                                <span className="max-w-[16rem] truncate">{label}</span>
                              )}
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
                          );
                        })}
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
