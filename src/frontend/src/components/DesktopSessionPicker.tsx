/**
 * Import from Claude Desktop: the desktop app's and the terminal's Claude
 * Code sessions under the project's repo path, minus those already on the
 * board. Choosing one creates a thread that continues it on the same session
 * id (both sides stay live). Palette-style overlay, like CommandPalette.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopSessionSummary } from '@nexus/shared';
import { api } from '../api';

interface Props {
  projectId: string;
  onImport: (session: DesktopSessionSummary) => Promise<void>;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export function DesktopSessionPicker({ projectId, onImport, onClose }: Props) {
  const [sessions, setSessions] = useState<DesktopSessionSummary[] | null>(null);
  const [desktopFound, setDesktopFound] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.projects.desktopSessions(projectId)
      .then((res) => {
        if (cancelled) return;
        setSessions(res.sessions);
        setDesktopFound(res.desktop.appFound);
      })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!sessions) return [];
    if (!q) return sessions;
    return sessions.filter((s) =>
      s.title.toLowerCase().includes(q)
      || (s.first_prompt ?? '').toLowerCase().includes(q)
      || (s.git_branch ?? '').toLowerCase().includes(q));
  }, [sessions, query]);

  const choose = async (index: number) => {
    const session = filtered[index];
    if (!session || importing) return;
    setImporting(session.id);
    setImportError(null);
    try {
      await onImport(session);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImporting(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(filtered.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); void choose(active); }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[12vh] backdrop-blur-xs"
      onClick={onClose}
      data-testid="desktop-session-picker"
    >
      <div
        role="dialog"
        aria-label="Import from Claude Desktop"
        className="w-full max-w-xl surface-glass border border-strong rounded-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder="Import a Claude Desktop or terminal session…"
          aria-label="Filter sessions"
          className="w-full bg-transparent px-4 py-3 text-sm text-primary placeholder:text-faint border-b border-subtle focus:outline-hidden"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {loadError && <div className="px-4 py-6 text-sm text-red-300">Could not list sessions: {loadError}</div>}
          {!loadError && sessions === null && <div className="px-4 py-6 text-sm text-faint text-center">Looking for sessions…</div>}
          {!loadError && sessions !== null && filtered.length === 0 && (
            <div className="px-4 py-6 text-sm text-faint text-center">
              {sessions.length === 0 ? (
                <>
                  <p>No Claude Desktop or terminal sessions to import for this project's repo path.</p>
                  <p className="mt-2 text-[11px]">Sessions Nexus started itself and sessions already on the board are not listed.</p>
                </>
              ) : 'No matches.'}
            </div>
          )}
          {filtered.map((session, i) => (
            <button
              key={session.id}
              type="button"
              onMouseMove={() => setActive(i)}
              onClick={() => void choose(i)}
              disabled={importing !== null}
              className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-sm text-left transition-colors disabled:opacity-60 ${
                i === active ? 'surface-active text-primary' : 'text-muted hover:bg-[var(--surface-hover)]'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate">{session.title}</span>
                {session.first_prompt && session.first_prompt !== session.title && (
                  <span className="block truncate text-[11px] text-faint">{session.first_prompt}</span>
                )}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-faint">
                {importing === session.id ? 'Importing…' : [session.git_branch, relativeTime(session.last_modified)].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-subtle text-[10px] text-faint">
          {importError ? (
            <span className="text-red-300">{importError}</span>
          ) : (
            <>
              <span>↑↓ navigate</span><span>⏎ import</span><span>esc close</span>
              {desktopFound === false && <span className="ml-auto text-amber-300/90">Claude Desktop not found here; terminal sessions only.</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
