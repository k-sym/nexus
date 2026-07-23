import { useEffect, useMemo, useState } from 'react';
import { Pulse, ArrowsClockwise, Copy, MagnifyingGlass, Prohibit, Play, Spinner } from '@phosphor-icons/react';
import type { Project, Task } from '@nexus/shared';
import type { ThreadMeta } from './Sidebar';
import type { ActivityResponse, Operation, OperationKind, OperationStatus } from '../api';

interface ActivityConsoleProps {
  operations: ActivityResponse | null;
  loading: boolean;
  projects: Project[];
  tasks: Task[];
  threads: ThreadMeta[];
  filters?: ActivityFilters;
  onFiltersChange?: (filters: ActivityFilters) => void;
  onRefresh: () => void;
  onSelectProject: (id: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onAbort: (id: string) => void;
  onRetry: (id: string) => void;
  onCopyDiagnostics: (id: string) => void;
}

interface ActivityFilters {
  kind: OperationKind | '';
  status: OperationStatus | '';
}

// Exhaustive over OperationKind by type, so a new kind fails the build here
// rather than rendering as a blank label and missing from the filter dropdown.
const KIND_LABELS: Record<OperationKind, string> = {
  chat_turn: 'Chat turn',
  assistant_stream: 'Assistant stream',
  jira_sync: 'Jira sync',
  github_sync: 'GitHub sync',
  monday_sync: 'Monday refresh',
  monday_write: 'Monday write',
  memory_archive: 'Memory archive',
  memory_index: 'Memory index',
  mission_tick: 'Mission tick',
};

const STATUS_COLORS: Record<OperationStatus, string> = {
  running: 'bg-emerald-500',
  succeeded: 'bg-blue-500',
  failed: 'bg-red-500',
  cancelled: 'bg-amber-500',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.valueOf())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function kindFromQuery(q: string): OperationKind | '' {
  const k = q as OperationKind;
  return KIND_LABELS[k] ? k : '';
}

function statusFromQuery(q: string): OperationStatus | '' {
  const s = q as OperationStatus;
  return STATUS_COLORS[s] ? s : '';
}

export default function ActivityConsole({
  operations,
  loading,
  projects,
  tasks,
  threads,
  filters,
  onFiltersChange,
  onRefresh,
  onSelectProject,
  onSelectThread,
  onAbort,
  onRetry,
  onCopyDiagnostics,
}: ActivityConsoleProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<OperationKind | ''>('');
  const [statusFilter, setStatusFilter] = useState<OperationStatus | ''>('');
  const activeKindFilter = filters?.kind ?? kindFilter;
  const activeStatusFilter = filters?.status ?? statusFilter;

  const allRows = useMemo(() => {
    if (!operations) return [];
    return [
      ...operations.running.map((r) => ({ ...r, live: true })),
      ...operations.recent.map((r) => ({ ...r, live: false })),
    ];
  }, [operations]);

  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      if (activeKindFilter && row.kind !== activeKindFilter) return false;
      if (activeStatusFilter && row.status !== activeStatusFilter) return false;
      if (search) {
        const hay = `${row.title} ${row.provider ?? ''} ${row.model ?? ''} ${row.error ?? ''}`.toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [allRows, activeKindFilter, activeStatusFilter, search]);

  const selected = useMemo(
    () => operations?.running.find((r) => r.id === selectedId) || operations?.recent.find((r) => r.id === selectedId) || null,
    [operations, selectedId],
  );

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selected, selectedId]);

  const projectName = (id?: string | null) => projects.find((p) => p.id === id)?.name ?? id ?? '—';
  const taskTitle = (id?: string | null) => tasks.find((t) => t.id === id)?.title ?? id ?? null;
  const threadTitle = (id?: string | null) => threads.find((t) => t.thread.id === id)?.thread.title ?? id ?? null;

  const updateKindFilter = (value: string) => {
    const kind = kindFromQuery(value);
    setKindFilter(kind);
    onFiltersChange?.({ kind, status: activeStatusFilter });
  };

  const updateStatusFilter = (value: string) => {
    const status = statusFromQuery(value);
    setStatusFilter(status);
    onFiltersChange?.({ kind: activeKindFilter, status });
  };

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <header className="surface-glass flex items-center justify-between px-6 py-4 border-b border-subtle shrink-0">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Pulse size={22} weight="fill" /> Activity Console
          </h1>
          <p className="text-xs text-faint">Running and recent Nexus work.</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-1.5 text-sm text-muted hover:text-[var(--text-primary)] border border-subtle rounded-md hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] transition-colors flex items-center gap-2"
        >
          {loading ? <Spinner size={14} className="animate-spin" /> : '↻'}
          Refresh
        </button>
      </header>

      <div className="p-4 border-b border-subtle shrink-0 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search operations…"
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--surface-hover)] border border-subtle rounded-md text-primary placeholder:text-faint focus:outline-hidden focus:border-[var(--border-strong)]"
          />
        </div>
        <select
          value={activeKindFilter}
          onChange={(e) => updateKindFilter(e.target.value)}
          className="text-sm bg-[var(--surface-hover)] border border-subtle rounded-md px-2 py-1.5 text-primary"
        >
          <option value="">All kinds</option>
          {Object.entries(KIND_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={activeStatusFilter}
          onChange={(e) => updateStatusFilter(e.target.value)}
          className="text-sm bg-[var(--surface-hover)] border border-subtle rounded-md px-2 py-1.5 text-primary"
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <div className="ml-auto flex gap-3 text-xs text-faint">
          {operations && (
            <>
              <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${STATUS_COLORS.running}`} /> {operations.counts.running ?? 0} running</span>
              <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${STATUS_COLORS.succeeded}`} /> {operations.counts.succeeded ?? 0} succeeded</span>
              <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${STATUS_COLORS.failed}`} /> {operations.counts.failed ?? 0} failed</span>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 overflow-auto">
          {filteredRows.length === 0 ? (
            <div className="p-8 text-center text-sm text-faint">No operations match the current filters.</div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="sticky top-0 surface-glass text-xs uppercase tracking-wider text-faint border-b border-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">What / Where</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Provider · Model</th>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {filteredRows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    className={`cursor-pointer hover:bg-[var(--surface-hover)] ${selectedId === row.id ? 'surface-active' : ''}`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[row.status]}`} />
                        <span className="text-muted">{KIND_LABELS[row.kind]}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 max-w-xs truncate text-muted" title={row.title}>
                      {row.title}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs">
                      <span className={`px-2 py-0.5 rounded-full border ${row.status === 'running' ? 'border-emerald-500/30 text-emerald-400' : row.status === 'failed' ? 'border-red-500/30 text-red-400' : row.status === 'cancelled' ? 'border-amber-500/30 text-amber-400' : 'border-blue-500/30 text-blue-400'}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-faint text-xs">
                      {row.provider && row.model ? `${row.provider} · ${row.model}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-faint text-xs">
                      {row.status === 'running' ? formatDuration(row.duration_ms) : `${formatTime(row.started_at)} · ${formatDuration(row.duration_ms)}`}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        {row.status === 'running' && (
                          <button
                            onClick={() => onAbort(row.id)}
                            title="Stop"
                            className="p-1.5 text-faint hover:text-red-400 rounded-md hover:bg-[var(--surface-hover)]"
                          >
                            <Prohibit size={16} />
                          </button>
                        )}
                        {(row.kind === 'memory_archive' || row.kind === 'jira_sync' || row.kind === 'github_sync') && row.status !== 'running' && (
                          <button
                            onClick={() => onRetry(row.id)}
                            title="Retry"
                            className="p-1.5 text-faint hover:text-blue-400 rounded-md hover:bg-[var(--surface-hover)]"
                          >
                            <ArrowsClockwise size={16} />
                          </button>
                        )}
                        <button
                          onClick={() => onCopyDiagnostics(row.id)}
                          title="Copy diagnostics"
                          className="p-1.5 text-faint hover:text-[var(--text-primary)] rounded-md hover:bg-[var(--surface-hover)]"
                        >
                          <Copy size={16} />
                        </button>
                        {row.thread_id && (
                          <button
                            onClick={() => row.thread_id && onSelectThread(row.project_id ?? projects[0]?.id ?? '', row.thread_id)}
                            title="Open thread"
                            className="p-1.5 text-faint hover:text-[var(--text-primary)] rounded-md hover:bg-[var(--surface-hover)]"
                          >
                            <Play size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected && (
          <div className="w-72 border-l border-subtle surface-glass overflow-y-auto p-4 shrink-0">
            <h3 className="text-sm font-semibold text-primary mb-1">{KIND_LABELS[selected.kind]}</h3>
            <p className="text-xs text-muted mb-4 break-words">{selected.title}</p>

            <DetailField label="Status" value={selected.status} />
            {selected.project_id && (
              <DetailField
                label="Project"
                value={projectName(selected.project_id)}
                onClick={() => onSelectProject(selected.project_id!)}
              />
            )}
            {selected.task_id && <DetailField label="Task" value={taskTitle(selected.task_id) ?? selected.task_id ?? ''} />}
            {selected.thread_id && (
              <DetailField
                label="Thread"
                value={threadTitle(selected.thread_id) ?? selected.thread_id ?? ''}
                onClick={() => onSelectThread(selected.project_id ?? projects[0]?.id ?? '', selected.thread_id!)}
              />
            )}
            <DetailField label="Provider" value={selected.provider ?? '—'} />
            <DetailField label="Model" value={selected.model ?? '—'} />
            <DetailField label="Started" value={formatTime(selected.started_at)} />
            <DetailField label="Duration" value={formatDuration(selected.duration_ms)} />
            {selected.last_event && <DetailField label="Last event" value={selected.last_event} />}
            {selected.error && <DetailField label="Error" value={selected.error} error />}
            {Boolean(selected.usage) && typeof selected.usage === 'object' && selected.usage !== null && (
              <DetailField
                label="Usage"
                value={formatUsage(selected.usage as Record<string, unknown>)}
              />
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {selected.status === 'running' && (
                <button onClick={() => onAbort(selected.id)} className="px-3 py-1.5 text-xs border border-red-500/30 text-red-400 rounded-md hover:bg-red-500/10 flex items-center gap-1">
                  <Prohibit size={14} /> Stop
                </button>
              )}
              {(selected.kind === 'memory_archive' || selected.kind === 'jira_sync' || selected.kind === 'github_sync') && selected.status !== 'running' && (
                <button onClick={() => onRetry(selected.id)} className="px-3 py-1.5 text-xs border border-blue-500/30 text-blue-400 rounded-md hover:bg-blue-500/10 flex items-center gap-1">
                  <ArrowsClockwise size={14} /> Retry
                </button>
              )}
              <button onClick={() => onCopyDiagnostics(selected.id)} className="px-3 py-1.5 text-xs border border-subtle rounded-md hover:bg-[var(--surface-hover)] flex items-center gap-1">
                <Copy size={14} /> Copy diagnostics
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  onClick,
  error,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  error?: boolean;
}) {
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-0.5">{label}</div>
      {onClick ? (
        <button onClick={onClick} className="text-xs text-left text-blue-400 hover:underline break-words">
          {value}
        </button>
      ) : (
        <div className={`text-xs break-words ${error ? 'text-red-400' : 'text-muted'}`}>{value}</div>
      )}
    </div>
  );
}

function formatUsage(usage: Record<string, unknown>): string {
  const parts: string[] = [];
  if (usage.percent !== undefined) parts.push(`${usage.percent}% context`);
  if (usage.tokens !== undefined && usage.contextWindow !== undefined) parts.push(`${usage.tokens}/${usage.contextWindow} tokens`);
  return parts.join(' · ') || JSON.stringify(usage);
}
