import { useState, useEffect, useRef, useMemo } from 'react';

export interface Command {
  id: string;
  label: string;
  /** short right-aligned category/hint, e.g. "Project", "Agent", "Action" */
  hint?: string;
  /** keywords to widen matching beyond the label */
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

export default function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // focus after the element mounts
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c => `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => {
    setActive(a => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // keep the active row in view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh] backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl surface-glass border border-strong rounded-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder="Jump to a project, view, or agent — or run an action…"
          className="w-full bg-transparent px-4 py-3 text-sm text-primary placeholder:text-faint border-b border-subtle focus:outline-hidden"
        />
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-sm text-faint text-center">No matches.</div>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              data-idx={i}
              onMouseMove={() => setActive(i)}
              onClick={() => run(i)}
              className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-sm text-left transition-colors ${
                i === active ? 'surface-active text-primary' : 'text-muted hover:bg-[var(--surface-hover)]'
              }`}
            >
              <span className="truncate">{c.label}</span>
              {c.hint && <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">{c.hint}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-subtle text-[10px] text-faint">
          <span>↑↓ navigate</span><span>⏎ select</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
