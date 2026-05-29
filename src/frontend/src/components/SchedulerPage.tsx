import { useState, useEffect, useCallback } from 'react';
import { Persona } from '@nexus/shared';
import { api } from '../api';

interface SchedulerPageProps {
  projectId: string;
}

const CRON_PRESETS = [
  { label: 'Every day at 9 AM', value: '0 9 * * *' },
  { label: 'Every weekday at 9 AM', value: '0 9 * * 1-5' },
  { label: 'Every Monday at 9 AM', value: '0 9 * * 1' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every day at midnight', value: '0 0 * * *' },
  { label: 'Every Sunday at midnight', value: '0 0 * * 0' },
];

export default function SchedulerPage({ projectId }: SchedulerPageProps) {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [taskTemplate, setTaskTemplate] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [agentId, setAgentId] = useState('cron-runner');

  const loadSchedules = useCallback(async () => {
    try {
      setSchedules(await api.schedules.list(projectId));
    } catch (err) {
      console.error('Failed to load schedules:', err);
    }
  }, [projectId]);

  useEffect(() => {
    loadSchedules();
    api.personas.list().then(setPersonas).catch(console.error);
  }, [loadSchedules]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !taskTemplate.trim()) return;
    try {
      await api.schedules.create(projectId, {
        name: name.trim(),
        cron_expr: cronExpr,
        task_template: taskTemplate.trim(),
        task_description: taskDescription.trim(),
        agent_id: agentId,
      });
      setName('');
      setTaskTemplate('');
      setTaskDescription('');
      setShowForm(false);
      await loadSchedules();
    } catch (err: any) {
      alert(`Failed to create schedule: ${err.message}`);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await api.schedules.update(id, { enabled: !enabled });
    await loadSchedules();
  };

  const handleDelete = async (id: string) => {
    await api.schedules.delete(id);
    await loadSchedules();
  };

  const formatNextRun = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString();
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Scheduler</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Recurring tasks that auto-dispatch to agents on a cron schedule</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-indigo-500 text-white text-sm rounded-lg hover:bg-indigo-600 transition-colors"
        >
          {showForm ? 'Cancel' : '+ New Schedule'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6 space-y-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Schedule Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Daily standup digest"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Schedule (cron)</label>
            <div className="flex gap-2">
              <select
                value={CRON_PRESETS.find(p => p.value === cronExpr)?.value || ''}
                onChange={e => e.target.value && setCronExpr(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm text-zinc-200 focus:outline-none"
              >
                <option value="">Custom</option>
                {CRON_PRESETS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={cronExpr}
                onChange={e => setCronExpr(e.target.value)}
                placeholder="0 9 * * *"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
              />
            </div>
            <p className="text-[10px] text-zinc-600 mt-1">Format: minute hour day-of-month month day-of-week</p>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Task Title (created each run)</label>
            <input
              type="text"
              value={taskTemplate}
              onChange={e => setTaskTemplate(e.target.value)}
              placeholder="Generate daily standup digest"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Task Description</label>
            <textarea
              value={taskDescription}
              onChange={e => setTaskDescription(e.target.value)}
              placeholder="Summarize what was completed yesterday and what's planned for today."
              rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Agent</label>
            <select
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none"
            >
              {personas.map(p => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!name.trim() || !taskTemplate.trim()}
              className="px-4 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Create Schedule
            </button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {schedules.map(sched => (
          <div key={sched.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${sched.enabled ? 'bg-green-500' : 'bg-zinc-600'}`} />
                  <h3 className="text-sm font-medium">{sched.name}</h3>
                </div>
                <p className="text-xs text-zinc-500 mt-1">{sched.description_human}</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Task: <span className="text-zinc-400">{sched.task_template}</span> · Agent: <span className="text-zinc-400">{sched.agent_id}</span>
                </p>
                <div className="flex gap-4 mt-2 text-[10px] text-zinc-600">
                  <span>Next: {formatNextRun(sched.next_run)}</span>
                  <span>Last: {formatNextRun(sched.last_run)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggle(sched.id, sched.enabled)}
                  className={`text-xs px-2 py-1 rounded transition-colors ${sched.enabled ? 'text-green-400 hover:text-green-300' : 'text-zinc-500 hover:text-zinc-400'}`}
                >
                  {sched.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                  onClick={() => handleDelete(sched.id)}
                  className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {schedules.length === 0 && !showForm && (
          <div className="text-center py-12">
            <p className="text-zinc-500 text-sm mb-2">No schedules yet</p>
            <button onClick={() => setShowForm(true)} className="text-indigo-500 text-sm hover:underline">
              Create your first schedule
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
