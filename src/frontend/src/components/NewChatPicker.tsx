import { useState } from 'react';
import { PersonaIcon } from '../personaIcons';

export interface PersonaChoice { slug: string; name: string; icon?: string; color: string; }

export default function NewChatPicker({
  personas, onStart, onClose,
}: {
  personas: PersonaChoice[];
  onStart: (slug: string, mode: 'chat' | 'terminal') => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(personas[0]?.slug ?? '');
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat');
  if (personas.length === 0) {
    return <div className="p-3 text-xs text-zinc-500">No personas yet — create one under Agents.</div>;
  }
  return (
    <div className="w-60 rounded-lg border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">New chat — pick a persona</div>
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
      <div className="flex gap-1 px-1 pt-2">
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
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        <button onClick={() => onStart(selected, mode)} className="px-3 py-1 text-xs bg-indigo-500 text-ink rounded-md hover:bg-indigo-600">Start</button>
      </div>
    </div>
  );
}
