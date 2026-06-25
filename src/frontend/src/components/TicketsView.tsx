import { useState, useEffect, useCallback } from 'react';
import { Ticket as TicketIcon, ArrowClockwise, Eye } from '@phosphor-icons/react';
import { Project, Ticket, TicketDescription } from '@nexus/shared';
import { api } from '../api';
import TriageToProject from './TriageToProject';

const STATUS_ORDER = ['Waiting for support', 'In Progress', 'Waiting for customer'];

const PRIORITY_CLASS: Record<string, string> = {
  Urgent: 'ticket-priority-urgent',
  High: 'ticket-priority-high',
  Medium: 'ticket-priority-medium',
  Low: 'ticket-priority-low',
};

function priorityClass(priority: string): string {
  return `ticket-priority-pill ${PRIORITY_CLASS[priority] ?? 'ticket-priority-low'}`;
}

function groupByStatus(tickets: Ticket[]): [string, Ticket[]][] {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const s = t.status || 'Other';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(t);
  }
  return [...groups.entries()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a[0]);
    const ib = STATUS_ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

interface TicketsViewProps {
  projects: Project[];
  onCreateTask: (projectId: string, ticket: Ticket) => Promise<void>;
}

export default function TicketsView({ projects, onCreateTask }: TicketsViewProps) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Ticket | null>(null);

  const [desc, setDesc] = useState<TicketDescription | null>(null);
  const [descLoading, setDescLoading] = useState(false);
  const [descError, setDescError] = useState(false);
  const [showTrimmed, setShowTrimmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.tickets.list();
      setTickets(data);
      setSelected(prev => (prev ? data.find(t => t.key === prev.key) ?? null : null));
    } catch (err) {
      console.error('Failed to load tickets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDescription = useCallback(async (key: string, refresh = false) => {
    setDescLoading(true);
    setDescError(false);
    setShowTrimmed(false);
    try {
      setDesc(await api.tickets.description(key, refresh));
    } catch (err) {
      console.error('Failed to load ticket description:', err);
      setDescError(true);
      setDesc(null);
    } finally {
      setDescLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) loadDescription(selected.key);
    else { setDesc(null); setDescError(false); }
  }, [selected, loadDescription]);

  const groups = groupByStatus(tickets);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top row: list + detail */}
      <div className="flex min-h-0 flex-1">
        {/* List */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2"><TicketIcon size={22} weight="fill" /> Tickets</h1>
              <p className="text-xs text-zinc-500">Jira tickets assigned to you ({tickets.length}). Synced in; Jira stays canonical.</p>
            </div>
            <button
              onClick={load}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors"
            >
              {loading ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            {tickets.length === 0 && (
              <div className="text-sm text-zinc-600 text-center py-10">
                No tickets synced yet. They arrive from the Jira-sync cron (POST /api/jira/sync).
              </div>
            )}
            {groups.map(([statusName, group]) => (
              <div key={statusName}>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-2">
                  {statusName} ({group.length})
                </div>
                <div className="space-y-1.5">
                  {group.map(t => (
                    <button
                      key={t.key}
                      onClick={() => setSelected(t)}
                      className={`w-full text-left bg-zinc-900 border rounded-md px-4 py-2.5 transition-colors ${
                        selected?.key === t.key ? 'border-strong' : 'border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono accent-text shrink-0">{t.key}</span>
                        <span className="text-sm text-zinc-200 truncate flex-1">{t.summary}</span>
                        <span className={`shrink-0 ${priorityClass(t.priority)}`}>{t.priority}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="w-96 border-l border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0 overflow-y-auto">
          {selected ? (
            <div className="p-5 space-y-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono accent-text">{selected.key}</span>
                  <span className="text-[11px] text-zinc-500">{selected.status}</span>
                </div>
                <h2 className="text-base font-semibold text-zinc-100 leading-snug">{selected.summary}</h2>
              </div>

              <dl className="text-xs text-zinc-400 space-y-1.5">
                <div className="flex justify-between items-center"><dt className="text-zinc-500">Priority</dt><dd className={priorityClass(selected.priority)}>{selected.priority}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">Assignee</dt><dd>{selected.assignee ?? '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">Created</dt><dd>{selected.created ?? '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">Updated</dt><dd>{selected.updated ?? '—'}</dd></div>
              </dl>

              {selected.url && (
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-center text-sm accent-text hover:text-[var(--accent)] border border-zinc-800 hover:border-strong rounded-md py-2 transition-colors"
                >
                  Open in Jira ↗
                </a>
              )}

              <TriageToProject
                projects={projects}
                resetKey={selected.key}
                onCreate={(projectId) => onCreateTask(projectId, selected)}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-sm text-zinc-600 text-center">Select a ticket to view details and triage it into a project.</p>
            </div>
          )}
        </div>
      </div>

      {/* Full-width preview strip */}
      {selected && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 shrink-0 max-h-[45%] flex flex-col">
          <div className="flex items-center justify-between px-6 py-2 border-b border-zinc-800/60 shrink-0">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1.5">
              <Eye size={14} /> Content preview
            </span>
            <button
              onClick={() => loadDescription(selected.key, true)}
              title="Re-fetch from Jira"
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              <ArrowClockwise size={14} className={descLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-4 text-sm text-zinc-300 leading-relaxed">
            {descLoading && <p className="text-zinc-600">Loading…</p>}
            {!descLoading && descError && (
              <p className="text-red-400">Couldn’t load the description. <button onClick={() => loadDescription(selected.key, true)} className="underline">Retry</button></p>
            )}
            {!descLoading && !descError && desc && desc.empty && (
              <p className="text-zinc-600">No description on this ticket. Open it in Jira for full context.</p>
            )}
            {!descLoading && !descError && desc && !desc.empty && (
              <>
                <p className="whitespace-pre-wrap">{desc.body}</p>
                {desc.trimmed.length > 0 && (
                  <div className="mt-3">
                    <button
                      onClick={() => setShowTrimmed(v => !v)}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 underline"
                    >
                      {showTrimmed ? 'Hide' : `Show ${desc.trimmed.length} trimmed section${desc.trimmed.length > 1 ? 's' : ''}`} (headers / footers)
                    </button>
                    {showTrimmed && (
                      <div className="mt-2 space-y-2 border-l-2 border-zinc-800 pl-3">
                        {desc.trimmed.map((t, i) => (
                          <p key={i} className="whitespace-pre-wrap text-xs text-zinc-500">{t.text}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
