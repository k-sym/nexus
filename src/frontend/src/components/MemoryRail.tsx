import { useState, useEffect, useCallback } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { api } from '../api';
import RightRail from './RightRail';

interface MemoryRailProps {
  projectId: string;
  /** Navigate to the full Memory page for this project. */
  onOpenFull: () => void;
}

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  created_at: string;
}

const STORAGE_KEY = 'nexus.memoryRail.open';
const POLL_MS = 15_000;
const RECENT_LIMIT = 15;

export default function MemoryRail({ projectId, onOpenFull }: MemoryRailProps) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== 'false'; } catch { return true; }
  });
  const [recent, setRecent] = useState<MemoryRow[]>([]);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(open)); } catch { /* ignore */ }
  }, [open]);

  const load = useCallback(async () => {
    try {
      const rows = await api.memory.list(projectId);
      setRecent((rows as MemoryRow[]).slice(0, RECENT_LIMIT));
    } catch {
      /* keep last list on error */
    }
  }, [projectId]);

  // Load on project change + poll while open. No polling while collapsed.
  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [open, load]);

  const handleAdd = async () => {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      await api.memory.create(projectId, { content, category: 'general' });
      setDraft('');
      await load();
    } catch (err) {
      console.error('Failed to add memory:', err);
    } finally {
      setAdding(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(); }
  };

  return (
    <RightRail
      label="Memory"
      title="Memory"
      open={open}
      onOpenChange={setOpen}
      actions={(
        <button onClick={onOpenFull} title="Open full Memory page" className="flex items-center gap-1 text-xs text-faint hover:text-[var(--text-primary)] transition-colors">
          <ArrowSquareOut size={14} /> Open
        </button>
      )}
      footer={(
        <>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Add a memory… (Enter to save)"
            rows={2}
            className="w-full surface-panel border border-subtle rounded-md px-2 py-1.5 text-xs text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !draft.trim()}
            className="mt-1 w-full px-2 py-1 text-xs accent-button rounded-md disabled:opacity-40 transition-colors"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </>
      )}
    >
      <div className="space-y-1.5">
        {recent.length === 0 && (
          <div className="text-xs text-faint text-center py-6">No memories yet.</div>
        )}
        {recent.map(m => (
          <div key={m.id} className="surface-panel border border-subtle rounded-md px-2.5 py-2" title={m.content}>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider accent-text">{m.category}</span>
              {m.created_at && <span className="text-[10px] text-faint">{m.created_at.slice(0, 10)}</span>}
            </div>
            <p className="text-xs text-muted leading-relaxed line-clamp-3 break-words">{m.content}</p>
          </div>
        ))}
      </div>
    </RightRail>
  );
}
