import { useEffect, useState } from 'react';
import { DEFAULT_ROLE_MODELS, ROLE_NAMES, type RoleOverrides, type RoleModels, type ThreadRoles } from '@nexus/shared';
import { api } from '../api';
import { useModels } from '../hooks/useModels';

export function RoleRoster({ value, defaults = DEFAULT_ROLE_MODELS, onChange }: {
  value: RoleOverrides; defaults?: RoleModels; onChange: (value: RoleOverrides) => void;
}) {
  const { allModels = [] } = useModels();
  return <div className="space-y-2">{ROLE_NAMES.map(role => {
    const selected = value[role] ?? defaults[role];
    const model = allModels.find(m => `${m.provider}/${m.id}` === selected);
    return <label key={role} className="block text-xs text-muted capitalize">{role}
      <select aria-label={`${role} model`} className="block w-full min-h-11 surface-panel border border-subtle rounded-sm px-2 text-primary normal-case" value={value[role] ?? ''} onChange={event => {
        const next = { ...value }; if (event.target.value) next[role] = event.target.value; else delete next[role]; onChange(next);
      }}>
        <option value="">Default — {defaults[role]}</option>
        {value[role] && !model && <option value={selected}>{selected} (unavailable)</option>}
        {allModels.map(m => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name} · {m.provider}{m.configured === false ? ' (unavailable)' : ''}</option>)}
      </select>
      {(!model || model.configured === false) && <span className="text-amber-400 normal-case">Unavailable with the current engine configuration</span>}
    </label>;
  })}</div>;
}
export default function RolePicker({ threadId, value, onChange }: { threadId?: string; value?: RoleOverrides; onChange?: (value: RoleOverrides) => void }) {
  const [view, setView] = useState<ThreadRoles>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    setView(undefined); setError('');
    if (api.roles) void api.roles.get(threadId).then(result => { if (live) setView(result); }).catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [threadId]);
  if (!view?.enabled && !error) return null;
  return <details className="relative text-sm"><summary className="cursor-pointer min-h-11 flex items-center">Roles</summary>
    <div className="absolute z-40 left-0 top-full w-80 p-3 surface-panel border border-subtle rounded shadow-lg">
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {view && <fieldset disabled={saving}><RoleRoster value={value ?? view.overrides} defaults={view.defaults} onChange={next => {
        if (!threadId) { onChange?.(next); return; }
        setSaving(true); setError('');
        const patch = Object.fromEntries(ROLE_NAMES.filter(role => next[role] !== view.overrides[role]).map(role => [role, next[role] ?? null]));
        void api.roles.update(threadId, patch).then(setView).catch(err => setError(err.message)).finally(() => setSaving(false));
      }} /></fieldset>}
      <p className="text-xs text-faint mt-2">Changes apply to the next role call.</p>
    </div>
  </details>;
}
