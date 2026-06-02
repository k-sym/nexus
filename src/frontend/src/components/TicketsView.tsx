import { useState, useEffect, useCallback } from 'react';
import { Ticket as TicketIcon } from '@phosphor-icons/react';
import { Project, Ticket } from '@nexus/shared';
import { api } from '../api';

interface TicketsViewProps {
  projects: Project[];
  /** create a Kanban task from a ticket in the chosen project; resolves when done */
  onCreateTask: (projectId: string, ticket: Ticket) => Promise<void>;
}

// Known Jira status buckets first (the ones format_jira.py expects), then any others.
const STATUS_ORDER = ['Waiting for support', 'In Progress', 'Waiting for customer'];

const PRIORITY_COLOR: Record<string, string> = {
  Urgent: 'text-red-400',
  High: 'text-orange-400',
  Medium: 'text-amber-400',
  Low: 'text-zinc-400',
};

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

export default function TicketsView({ projects, onCreateTask }: TicketsViewProps) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [targetProject, setTargetProject] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [createdMsg, setCreatedMsg] = useState<string | null>(null);

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

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!targetProject && projects.length > 0) setTargetProject(projects[0].id);
  }, [projects, targetProject]);

  const handleCreate = async () => {
    if (!selected || !targetProject) return;
    setCreating(true);
    setCreatedMsg(null);
    try {
      await onCreateTask(targetProject, selected);
      const projName = projects.find(p => p.id === targetProject)?.name ?? 'project';
      setCreatedMsg(`Created in ${projName}`);
    } catch (err) {
      console.error('Failed to create task from ticket:', err);
      setCreatedMsg('Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  const groups = groupByStatus(tickets);

  return (
    <div className="flex-1 flex min-h-0">
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
                    onClick={() => { setSelected(t); setCreatedMsg(null); }}
                    className={`w-full text-left bg-zinc-900 border rounded-md px-4 py-2.5 transition-colors ${
                      selected?.key === t.key ? 'border-indigo-500/60' : 'border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-indigo-400/80 shrink-0">{t.key}</span>
                      <span className="text-sm text-zinc-200 truncate flex-1">{t.summary}</span>
                      <span className={`text-[11px] shrink-0 ${PRIORITY_COLOR[t.priority] ?? 'text-zinc-400'}`}>{t.priority}</span>
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
                <span className="text-xs font-mono text-indigo-400/80">{selected.key}</span>
                <span className="text-[11px] text-zinc-500">{selected.status}</span>
              </div>
              <h2 className="text-base font-semibold text-zinc-100 leading-snug">{selected.summary}</h2>
            </div>

            <dl className="text-xs text-zinc-400 space-y-1.5">
              <div className="flex justify-between"><dt className="text-zinc-500">Priority</dt><dd className={PRIORITY_COLOR[selected.priority] ?? ''}>{selected.priority}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-500">Assignee</dt><dd>{selected.assignee ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-500">Created</dt><dd>{selected.created ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-zinc-500">Updated</dt><dd>{selected.updated ?? '—'}</dd></div>
            </dl>

            {selected.url && (
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-sm text-indigo-400 hover:text-indigo-300 border border-zinc-800 rounded-md py-2 transition-colors"
              >
                Open in Jira ↗
              </a>
            )}

            <div className="border-t border-zinc-800 pt-4 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Triage → create task</div>
              {projects.length === 0 ? (
                <p className="text-xs text-zinc-600">Create a project first to triage this into a Kanban task.</p>
              ) : (
                <>
                  <select
                    value={targetProject}
                    onChange={e => setTargetProject(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-2 text-sm text-zinc-200 focus:outline-none"
                  >
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleCreate}
                    disabled={creating}
                    className="w-full px-3 py-2 text-sm bg-indigo-500 text-white rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors"
                  >
                    {creating ? 'Creating…' : 'Create task'}
                  </button>
                  {createdMsg && <p className="text-xs text-emerald-400 text-center">{createdMsg}</p>}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-sm text-zinc-600 text-center">Select a ticket to view details and triage it into a project.</p>
          </div>
        )}
      </div>
    </div>
  );
}
