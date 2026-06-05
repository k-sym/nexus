import { useEffect, useState } from 'react';
import { PersonaIcon } from '../personaIcons';
import { api } from '../api';

export interface PersonaChoice { slug: string; name: string; icon?: string; color: string; }

export default function NewChatPicker({
  personas, onStart, onClose,
}: {
  personas: PersonaChoice[];
  onStart: (slug: string, mode: 'chat' | 'terminal', launchCommand?: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(personas[0]?.slug ?? '');
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat');
  const [command, setCommand] = useState('');

  // For a terminal thread, pre-fill the launch command from the persona's
  // resolved default whenever the mode/persona changes. The user can then edit
  // it freely before starting. Stale responses (selection changed mid-flight)
  // are ignored via the `cancelled` guard.
  useEffect(() => {
    if (mode !== 'terminal' || !selected) return;
    let cancelled = false;
    setCommand('');
    api.personas.launchCommand(selected)
      .then(r => { if (!cancelled) setCommand(r.command); })
      .catch(() => { if (!cancelled) setCommand(''); });
    return () => { cancelled = true; };
  }, [mode, selected]);

  if (personas.length === 0) {
    return <div className="p-3 text-xs text-zinc-500">No personas yet — create one under Agents.</div>;
  }
  return (
    <div className="w-60 rounded-lg border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">New chat — pick a mode</div>
      <div className="flex gap-1 px-1 pb-2">
        {(['chat', 'terminal'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 px-2 py-1 text-xs rounded-md border transition-colors ${mode === m ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'}`}
          >
            {m === 'chat' ? 'Chat' : 'Terminal'}
          </button>
        ))}
      </div>
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">Persona</div>
      <div className="max-h-56 overflow-y-auto">
        {personas.map(p => (
          <button
            key={p.slug}
            onClick={() => setSelected(p.slug)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${selected === p.slug ? 'bg-indigo-500/20 text-white' : 'text-zinc-400 hover:bg-zinc-800/40'}`}
          >
            <PersonaIcon icon={p.icon} color={p.color} />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
      {mode === 'terminal' && (
        <div className="px-1 pt-2">
          <label className="block pb-1 text-[10px] uppercase tracking-wider text-zinc-500">Launch command (runs on open)</label>
          <textarea
            value={command}
            onChange={e => setCommand(e.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button onClick={() => onStart(selected, mode, mode === 'terminal' ? command : undefined)} className="px-3 py-1 text-xs bg-indigo-500 text-ink rounded-md hover:bg-indigo-600">Start</button>
      </div>
    </div>
  );
}
