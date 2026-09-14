import { useCallback, useEffect, useState } from 'react';
import type { AgentBridgeProjectScope } from '@nexus/shared';
import { api } from '../api';

export function AgentBridgeScopeSettings({ onSaved }: { onSaved?: () => void }) {
  const [projects, setProjects] = useState<AgentBridgeProjectScope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProjects((await api.agentBridge.projects()).projects);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load bridge projects.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className="border-t border-subtle pt-3 space-y-3">
    <h3 className="text-xs font-medium text-muted">Project delivery scope</h3>
    <p className="text-xs text-faint">Projects start disabled. Save each project's scope here; changes apply immediately. The global bridge switch and sender allowlist still apply.</p>
    {loading && <p className="text-xs text-faint">Loading projects…</p>}
    {error && <div role="alert" className="text-xs text-red-400">{error} <button type="button" className="min-h-11 px-3 underline" onClick={() => void load()}>Retry loading projects</button></div>}
    {!loading && !error && projects.length === 0 && <p className="text-xs text-faint">No projects yet.</p>}
    {projects.map(project => <ProjectScope key={project.id} project={project} onSaved={onSaved} />)}
  </div>;
}

function ProjectScope({ project, onSaved }: { project: AgentBridgeProjectScope; onSaved?: () => void }) {
  const [policy, setPolicy] = useState({ enabled: project.enabled, thread_ids: project.thread_ids });
  const [saved, setSaved] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(saved) !== JSON.stringify(policy);
  const save = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api.agentBridge.setPolicy(project.id, policy);
      const next = { enabled: result.enabled, thread_ids: result.thread_ids };
      setSaved(next); setPolicy(next); setMessage('Scope saved.'); onSaved?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save scope.'); }
    finally { setBusy(false); }
  };
  return <fieldset disabled={busy} className="surface-panel border border-subtle rounded-sm p-3 space-y-2">
    <legend className="px-1 text-xs font-medium text-primary">{project.name}</legend>
    <label className="flex items-center gap-2 min-h-11 text-xs text-primary">
      <input type="checkbox" checked={policy.enabled} onChange={event => { setPolicy({ ...policy, enabled: event.target.checked }); setMessage(null); }} />
      Enable bridge delivery for {project.name}
    </label>
    <label className="block text-xs text-muted">Threads for {project.name}
      <select value={policy.thread_ids === null ? 'all' : 'selected'} onChange={event => { setPolicy({ ...policy, thread_ids: event.target.value === 'all' ? null : [] }); setMessage(null); }} className="block mt-1 min-h-11 w-full surface-panel border border-subtle rounded-sm px-3 text-sm text-primary">
        <option value="all">All threads</option><option value="selected">Selected threads</option>
      </select>
    </label>
    {policy.thread_ids !== null && <div className="space-y-1 max-h-64 overflow-y-auto">
      {project.threads.map(thread => <label key={thread.id} className="flex items-center gap-2 min-h-11 text-xs text-primary">
        <input type="checkbox" checked={policy.thread_ids!.includes(thread.id)} onChange={event => {
          const ids = policy.thread_ids ?? [];
          setPolicy({ ...policy, thread_ids: event.target.checked ? [...ids, thread.id] : ids.filter(id => id !== thread.id) }); setMessage(null);
        }} />{thread.title || thread.id}
      </label>)}
      {policy.thread_ids.length === 0 && <p className="text-xs text-faint">No threads selected: delivery is blocked for this project.</p>}
    </div>}
    <button type="button" disabled={!dirty || busy} onClick={() => void save()} className="min-h-11 px-3 rounded-sm accent-button text-xs disabled:opacity-40">{busy ? 'Saving…' : `Save scope for ${project.name}`}</button>
    {message && <p role="status" className="text-xs text-green-400">{message}</p>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </fieldset>;
}
