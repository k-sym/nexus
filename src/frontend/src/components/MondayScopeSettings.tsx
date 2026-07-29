/**
 * Configure a project's Monday scope: board, optional group, roll-up column,
 * updates cadence, and status sync. Rendered by ProjectManagementView both when
 * a project has no scope yet (in place of the error screen — see the brief's
 * Task 15) and from a "Configure" control once one exists.
 *
 * This panel never offers a token field: MONDAY_TOKEN stays the only token
 * source, and the PUT this component calls does not accept or store one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, MONDAY_STATUS_SYNC_DEFAULT_MAPPING,
  type MondayProjectConfig, type TaskStatus,
} from '@nexus/shared';
import {
  fetchMondayBoards, fetchMondayBoardMeta, saveMondayProjectConfig,
  type MondayBoardSummary, type MondayBoardMetaResult, type MondayStatusLabel, type FetchJsonError,
} from '../api';

interface Props {
  projectId: string;
  current: MondayProjectConfig | null;
  onSaved: () => void;
  onCancel?: () => void;
}

const DEFAULT_MIN_INTERVAL_MINUTES = 30;

/** Must match MIN_UPDATE_INTERVAL_MINUTES in backend/routes/monday.ts — the
 *  server clamps up to this floor silently, so the client shows the same
 *  number rather than letting a smaller value look accepted and then land
 *  on something else. */
const MIN_UPDATE_INTERVAL_MINUTES = 5;

/** Monday's own reported column type, never the (user-renamable) column id —
 *  see the column_type doc comment on MondayProjectConfig in shared/index.ts.
 *  '2026-07' has reported "numbers" for every numeric column seen so far;
 *  'numeric' is tolerated too in case a future API version renames it. */
function columnTypeFor(mondayType: string): 'text' | 'numeric' {
  return mondayType === 'numbers' || mondayType === 'numeric' ? 'numeric' : 'text';
}

/** Prefill the status mapping from the recommended defaults, keeping only the
 *  columns whose default label text actually exists on the chosen status column
 *  (matched case-insensitively, adopting the board's own casing). */
function defaultMappingFor(labels: MondayStatusLabel[]): Partial<Record<TaskStatus, string>> {
  const byLower = new Map(labels.map((l) => [l.text.toLowerCase(), l.text]));
  const out: Partial<Record<TaskStatus, string>> = {};
  for (const col of KANBAN_COLUMNS) {
    const wanted = MONDAY_STATUS_SYNC_DEFAULT_MAPPING[col];
    if (!wanted) continue;
    const match = byLower.get(wanted.toLowerCase());
    if (match) out[col] = match;
  }
  return out;
}

export function MondayScopeSettings({ projectId, current, onSaved, onCancel }: Props) {
  const [boards, setBoards] = useState<MondayBoardSummary[] | null>(null);
  const [boardsError, setBoardsError] = useState<string | null>(null);

  const [boardId, setBoardId] = useState(current?.board_id ?? '');
  const [groupId, setGroupId] = useState<string | null>(current?.group_id ?? null);

  const [meta, setMeta] = useState<MondayBoardMetaResult | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [rollupEnabled, setRollupEnabled] = useState(current?.rollup.enabled ?? false);
  const [rollupColumnId, setRollupColumnId] = useState<string | null>(current?.rollup.column_id ?? null);
  const [rollupColumnType, setRollupColumnType] = useState<'text' | 'numeric'>(current?.rollup.column_type ?? 'text');

  const [updatesEnabled, setUpdatesEnabled] = useState(current?.updates.enabled ?? false);
  // Kept as the raw text the user typed, not a number: `Number('')` is `0`,
  // not NaN, so a number-typed state would let an emptied field silently
  // become a "valid" 0 and sail past validation. See minIntervalIsValid below.
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(
    String(current?.updates.min_interval_minutes ?? DEFAULT_MIN_INTERVAL_MINUTES),
  );

  const [statusSyncEnabled, setStatusSyncEnabled] = useState(current?.status_sync?.enabled ?? false);
  const [statusColumnId, setStatusColumnId] = useState<string | null>(current?.status_sync?.column_id ?? null);
  const [forwardOnly, setForwardOnly] = useState(current?.status_sync?.forward_only ?? true);
  const [statusMapping, setStatusMapping] = useState<Partial<Record<TaskStatus, string>>>(
    current?.status_sync?.mapping ?? {},
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Same monotonic-generation precedent ProjectManagementView uses: a board
  // meta load is triggered both on mount (to prefill an already-configured
  // board) and by user interaction (picking a different board), so a plain
  // per-effect `cancelled` boolean can't cover both call sites — a newer
  // selection must always win over an older in-flight one.
  const metaGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setBoardsError(null);
    (async () => {
      try {
        const list = await fetchMondayBoards();
        if (!cancelled) setBoards(list);
      } catch (err) {
        if (!cancelled) setBoardsError((err as FetchJsonError).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadMeta = useCallback(async (id: string) => {
    const generation = ++metaGenerationRef.current;
    setMetaError(null);
    setMetaLoading(true);
    try {
      const result = await fetchMondayBoardMeta(id);
      if (metaGenerationRef.current !== generation) return; // superseded
      setMeta(result);
    } catch (err) {
      if (metaGenerationRef.current !== generation) return; // superseded
      setMeta(null);
      setMetaError((err as FetchJsonError).message);
    } finally {
      if (metaGenerationRef.current === generation) setMetaLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-load metadata for an already-configured board so reopening the panel
  // (the header's "Configure" control) shows the existing group/column
  // choices instead of empty pickers.
  useEffect(() => {
    if (current?.board_id) void loadMeta(current.board_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleBoardChange(id: string) {
    setBoardId(id);
    setGroupId(null);
    setRollupColumnId(null);
    // The column and its type are derived together from one board's meta
    // (see columnTypeFor above) — resetting only the id would leave the
    // PREVIOUS board's column_type behind, associated with no column. Only
    // harmless today because a null column_id blocks saving roll-up enabled;
    // reset both so there is never a dangling stale type.
    setRollupColumnType('text');
    // A new board has different status columns and labels — the previous
    // column id and mapping cannot carry over.
    setStatusColumnId(null);
    setStatusMapping({});
    setMeta(null);
    setMetaError(null);
    if (id) void loadMeta(id);
  }

  function handleColumnChange(columnId: string) {
    const id = columnId || null;
    setRollupColumnId(id);
    const column = meta?.columns.find((c) => c.id === columnId);
    if (column) setRollupColumnType(columnTypeFor(column.type));
  }

  const statusColumns = (meta?.columns ?? []).filter((c) => c.type === 'status');
  const selectedStatusColumn = statusColumns.find((c) => c.id === statusColumnId) ?? null;
  const statusLabels: MondayStatusLabel[] = selectedStatusColumn?.labels ?? [];

  function handleStatusSyncToggle(checked: boolean) {
    setStatusSyncEnabled(checked);
    if (!checked) return;
    // Auto-select the sole status column, then prefill the mapping the first
    // time (only when nothing is mapped yet, so editing never clobbers a saved
    // mapping). Compute from meta directly rather than the render-derived list.
    const cols = (meta?.columns ?? []).filter((c) => c.type === 'status');
    let colId = statusColumnId;
    if (!colId && cols.length === 1) {
      colId = cols[0]!.id;
      setStatusColumnId(colId);
    }
    const labels = cols.find((c) => c.id === colId)?.labels ?? [];
    if (Object.keys(statusMapping).length === 0 && labels.length > 0) {
      setStatusMapping(defaultMappingFor(labels));
    }
  }

  function handleStatusColumnChange(id: string) {
    const colId = id || null;
    setStatusColumnId(colId);
    const labels = (meta?.columns ?? []).find((c) => c.id === colId)?.labels ?? [];
    if (Object.keys(statusMapping).length === 0 && labels.length > 0) {
      setStatusMapping(defaultMappingFor(labels));
    }
  }

  function setMappingFor(col: TaskStatus, label: string) {
    setStatusMapping((prev) => {
      const next = { ...prev };
      if (label) next[col] = label;
      else delete next[col];
      return next;
    });
  }

  // `Number('')` is 0, not NaN, so the empty-string case is checked
  // explicitly rather than relying on Number.isFinite alone — an emptied
  // field must never look like a valid 0-minute interval (the server treats
  // <= 0 as a hard rejection, not something it clamps).
  const parsedMinInterval = Number(minIntervalMinutes);
  const minIntervalIsValid = minIntervalMinutes.trim() !== ''
    && Number.isFinite(parsedMinInterval)
    && parsedMinInterval > 0;

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      const config: MondayProjectConfig = {
        board_id: boardId,
        group_id: groupId,
        rollup: { enabled: rollupEnabled, column_id: rollupColumnId, column_type: rollupColumnType },
        updates: { enabled: updatesEnabled, min_interval_minutes: parsedMinInterval },
        status_sync: {
          enabled: statusSyncEnabled,
          column_id: statusColumnId,
          forward_only: forwardOnly,
          mapping: statusMapping,
        },
      };
      const saved = await saveMondayProjectConfig(projectId, config);
      // The PUT returns the clamped, canonical config it actually stored
      // (e.g. min_interval_minutes floored to MIN_UPDATE_INTERVAL_MINUTES).
      // Adopt it so the panel reflects exactly what was saved rather than
      // the pre-clamp value the user typed. Guarded, not assumed present:
      // some tests (and any future caller) may resolve with a partial stub.
      if (saved && saved.rollup && saved.updates) {
        setBoardId(saved.board_id);
        setGroupId(saved.group_id ?? null);
        setRollupEnabled(saved.rollup.enabled);
        setRollupColumnId(saved.rollup.column_id);
        setRollupColumnType(saved.rollup.column_type);
        setUpdatesEnabled(saved.updates.enabled);
        setMinIntervalMinutes(String(saved.updates.min_interval_minutes));
        // status_sync is optional in the stored shape; adopt it when present.
        if (saved.status_sync) {
          setStatusSyncEnabled(saved.status_sync.enabled);
          setStatusColumnId(saved.status_sync.column_id);
          setForwardOnly(saved.status_sync.forward_only);
          setStatusMapping(saved.status_sync.mapping ?? {});
        }
      }
      onSaved();
    } catch (err) {
      setSaveError((err as FetchJsonError).message);
    } finally {
      setSaving(false);
    }
  }

  const canSave = Boolean(boardId)
    && (!rollupEnabled || Boolean(rollupColumnId))
    && (!statusSyncEnabled || Boolean(statusColumnId))
    && minIntervalIsValid
    && !saving;

  // The roll-up column picker has nothing to show before a board is chosen,
  // and nothing trustworthy to show after its metadata failed to load — both
  // would otherwise render as a plain empty <select>, which reads as "this
  // board has no columns" rather than "columns aren't available yet/at all".
  const rollupColumnsUnavailable = Boolean(metaError);
  const rollupSelectDisabled = !rollupEnabled || !boardId || rollupColumnsUnavailable;
  const rollupPlaceholder = !boardId
    ? 'Select a board first'
    : rollupColumnsUnavailable
      ? 'Columns unavailable — board metadata failed to load'
      : 'Select a column…';

  return (
    <div className="space-y-4 max-w-lg">
      <h2 className="text-lg font-semibold text-zinc-100">Configure Monday scope</h2>
      <p className="text-sm text-zinc-500">
        Choose the Monday board (and optionally a single group) this project tracks. The token comes from the
        server&apos;s MONDAY_TOKEN — it is never entered here.
      </p>

      <section className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Scope</h3>

        <div>
          <label htmlFor="monday-scope-board" className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">
            Board
          </label>
          {boards === null ? (
            boardsError ? (
              <p role="alert" className="text-sm text-red-400">{boardsError}</p>
            ) : (
              <p className="text-sm text-zinc-500">Loading boards…</p>
            )
          ) : (
            <select
              id="monday-scope-board"
              aria-label="Board"
              value={boardId}
              onChange={(event) => handleBoardChange(event.target.value)}
              className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
            >
              <option value="">Select a board…</option>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}{board.workspace ? ` (${board.workspace})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {boardId ? (
          <div>
            <label htmlFor="monday-scope-group" className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">
              Group
            </label>
            {metaLoading ? (
              <p className="text-sm text-zinc-500">Loading groups and columns…</p>
            ) : metaError ? (
              <p role="alert" className="text-sm text-red-400">{metaError}</p>
            ) : (
              <select
                id="monday-scope-group"
                aria-label="Group"
                value={groupId ?? ''}
                onChange={(event) => setGroupId(event.target.value || null)}
                className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
              >
                <option value="">Whole board</option>
                {(meta?.groups ?? []).map((group) => (
                  <option key={group.id} value={group.id}>{group.title}</option>
                ))}
              </select>
            )}
          </div>
        ) : null}
      </section>

      <section className="space-y-3 border-t border-white/10 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Write back to Monday</h3>

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={rollupEnabled}
              onChange={(event) => setRollupEnabled(event.target.checked)}
            />
            Write task roll-up to a column
          </label>
          <select
            aria-label="Roll-up column"
            value={rollupColumnId ?? ''}
            disabled={rollupSelectDisabled}
            onChange={(event) => handleColumnChange(event.target.value)}
            className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value="">{rollupPlaceholder}</option>
            {(meta?.columns ?? []).map((column) => (
              <option key={column.id} value={column.id}>{column.title} ({column.type})</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={updatesEnabled}
              onChange={(event) => {
                const checked = event.target.checked;
                setUpdatesEnabled(checked);
                // Turning updates off while the interval field holds an
                // invalid value (e.g. emptied while it was still editable)
                // would otherwise leave Save permanently disabled with no
                // visible input to fix, since the field is greyed out whenever
                // the toggle is off. Restore a sane value instead.
                if (!checked && !minIntervalIsValid) setMinIntervalMinutes(String(DEFAULT_MIN_INTERVAL_MINUTES));
              }}
            />
            Post progress to the item&apos;s updates feed
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={MIN_UPDATE_INTERVAL_MINUTES}
              aria-label="Update interval (minutes)"
              disabled={!updatesEnabled}
              value={minIntervalMinutes}
              onChange={(event) => setMinIntervalMinutes(event.target.value)}
              className="w-24 rounded border border-white/10 bg-transparent px-2 py-1 text-sm disabled:opacity-50"
            />
            <span className="text-sm text-zinc-500">minutes between updates (minimum {MIN_UPDATE_INTERVAL_MINUTES})</span>
          </div>
          {updatesEnabled && !minIntervalIsValid ? (
            <p role="alert" className="text-xs text-red-400">Enter a positive number of minutes.</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={statusSyncEnabled}
              onChange={(event) => handleStatusSyncToggle(event.target.checked)}
            />
            Sync task status to the Monday board
          </label>

          {statusSyncEnabled ? (
            !boardId ? (
              <p className="text-sm text-zinc-500 pl-6">Select a board first.</p>
            ) : metaLoading ? (
              <p className="text-sm text-zinc-500 pl-6">Loading columns…</p>
            ) : metaError ? (
              <p role="alert" className="text-sm text-red-400 pl-6">{metaError}</p>
            ) : statusColumns.length === 0 ? (
              <p role="alert" className="text-sm text-amber-400 pl-6">This board has no status column to write to.</p>
            ) : (
              <div className="space-y-3 pl-6">
                {statusColumns.length > 1 ? (
                  <div>
                    <label htmlFor="monday-status-column" className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">
                      Status column
                    </label>
                    <select
                      id="monday-status-column"
                      aria-label="Status column"
                      value={statusColumnId ?? ''}
                      onChange={(event) => handleStatusColumnChange(event.target.value)}
                      className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
                    >
                      <option value="">Select a status column…</option>
                      {statusColumns.map((column) => (
                        <option key={column.id} value={column.id}>{column.title}</option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {statusColumnId ? (
                  <div className="space-y-1.5">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Kanban column → Monday status</p>
                    {KANBAN_COLUMNS.map((col) => {
                      const selectedLabel = statusMapping[col] ?? '';
                      const swatch = statusLabels.find((l) => l.text === selectedLabel)?.color ?? null;
                      return (
                        <div key={col} className="flex items-center gap-2">
                          <span className="w-24 shrink-0 text-sm text-zinc-300">{KANBAN_COLUMN_LABELS[col]}</span>
                          <span
                            aria-hidden
                            data-testid={`swatch-${col}`}
                            className="inline-block h-3 w-3 shrink-0 rounded-sm border border-white/10"
                            style={{ backgroundColor: swatch ?? 'transparent' }}
                          />
                          <select
                            aria-label={`Monday status for ${KANBAN_COLUMN_LABELS[col]}`}
                            value={selectedLabel}
                            onChange={(event) => setMappingFor(col, event.target.value)}
                            className="flex-1 rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
                          >
                            <option value="">— don&apos;t change —</option>
                            {statusLabels.map((label) => (
                              <option key={label.index} value={label.text}>{label.text}</option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                    <label className="flex items-center gap-2 text-sm text-zinc-300 pt-1">
                      <input
                        type="checkbox"
                        checked={forwardOnly}
                        onChange={(event) => setForwardOnly(event.target.checked)}
                      />
                      Only advance status, never move it backwards
                    </label>
                    <p className="text-xs text-zinc-500">
                      Nexus never sets the human-owned inbox status, and won&apos;t overwrite a status you set to a
                      label outside this mapping.
                    </p>
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </div>
      </section>

      {saveError ? <p role="alert" className="text-sm text-red-400">{saveError}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void handleSave()}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
