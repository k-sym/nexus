import { useCallback, useEffect, useRef, useState } from 'react';
import { Browser, ArrowClockwise, CaretDown, CaretUp } from '@phosphor-icons/react';
import { fetchBrowserView, type BrowserView } from '../api';

/** Poll cadence while a session is open. Faster than the Docker panel: an agent
 *  drives a browser on second timescales, and this is "watch it happen". An
 *  unchanged page costs nothing — the server sends no bytes when the version
 *  hasn't moved. */
const POLL_MS = 3_000;

/**
 * The agent's headless browser, shown inline in its chat session so a developer
 * can watch a reproduction or verification happen (#283). In thin-client mode
 * the browser runs on baker-pro, so this polled preview is the *only* shared
 * view of it.
 *
 * Renders nothing when the thread has no browser open — a session that never
 * navigated sees no chrome at all, exactly like the Docker services panel.
 */
export default function BrowserViewPanel({ threadId }: { threadId: string | null }) {
  const [view, setView] = useState<BrowserView | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Read inside the interval without re-arming it every time the frame changes.
  const versionRef = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    if (!threadId) { setView(null); versionRef.current = undefined; return; }
    try {
      const res = await fetchBrowserView(threadId, versionRef.current);
      if (!res.present) { setView(null); versionRef.current = undefined; return; }
      // `unchanged` ⇒ the server withheld the bytes because our version is
      // current; keep the frame we already have.
      if (res.unchanged) return;
      if (res.view) { setView(res.view); versionRef.current = res.view.version; }
    } catch {
      // A transient failure shouldn't yank the panel; keep the last frame.
    }
  }, [threadId]);

  useEffect(() => {
    setView(null); // don't show the previous thread's page while the new one loads
    versionRef.current = undefined;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!view) return null;

  const label = view.title || view.url || 'about:blank';

  return (
    <div className="mx-4 mt-2 rounded-md border border-zinc-800 bg-zinc-900/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800/60">
        <Browser size={13} className="accent-text shrink-0" />
        <span className="text-zinc-300 truncate" title={view.url}>{label}</span>
        <span className="text-zinc-500 shrink-0">{view.viewport.width}×{view.viewport.height}</span>
        <span className="text-zinc-600 shrink-0">·</span>
        <span className="text-zinc-500 shrink-0">{view.colorScheme}</span>
        <div className="flex-1" />
        <button
          onClick={() => { void load(); }}
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Refresh now"
          aria-label="Refresh browser view"
        >
          <ArrowClockwise size={12} />
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
          title={collapsed ? 'Show page' : 'Hide page'}
          aria-label={collapsed ? 'Show browser view' : 'Hide browser view'}
        >
          {collapsed ? <CaretDown size={12} /> : <CaretUp size={12} />}
        </button>
      </div>
      {!collapsed && (
        <div className="flex justify-center bg-zinc-950/60 p-1.5">
          <img
            src={`data:${view.image.mimeType};base64,${view.image.data}`}
            alt={`Agent browser — ${label}`}
            className="max-h-72 w-auto max-w-full rounded-sm"
          />
        </div>
      )}
    </div>
  );
}
