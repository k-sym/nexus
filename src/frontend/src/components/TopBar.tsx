import { ChatCircle, Gauge, Ticket, Gear, Brain, Pulse, Rocket } from '@phosphor-icons/react';

export type GlobalView = 'dashboard' | 'activity' | 'missions' | 'tickets' | 'braindump' | 'assistant';
export type ManageView = 'settings';

interface TopBarProps {
  view: string;
  onSelectGlobal: (v: GlobalView) => void;
  onSelectManage: (v: ManageView) => void;
  onOpenPalette: () => void;
}

const item = (active: boolean) =>
  `shrink-0 flex items-center gap-1.5 px-3 py-1 text-sm rounded-md transition-colors whitespace-nowrap ${
    active ? 'surface-active accent-text' : 'text-muted hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
  }`;

export default function TopBar({ view, onSelectGlobal, onSelectManage, onOpenPalette }: TopBarProps) {
  // The Tauri shell hides the native title bar (TitleBarStyle::Overlay) and drags
  // via the `data-tauri-drag-region` attribute on the header below, so the TopBar
  // doubles as the drag handle. On macOS the traffic-light buttons overlay the
  // top-left, so we reserve space for them. Browser ("web") mode has neither.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isTauri =
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || (window as { isTauri?: boolean }).isTauri === true);
  const isMac = /Mac/i.test(ua);
  const chrome = isTauri && isMac ? ' mac-traffic-lights' : '';

  return (
    <header
      data-tauri-drag-region="deep"
      className={`h-12 shrink-0 flex items-center gap-1.5 px-3 border-b border-subtle surface-glass${chrome}`}
    >
      <div className="flex items-center gap-2 pr-1">
        <div className="w-6 h-6 rounded accent-button flex items-center justify-center text-[11px] font-bold">N</div>
        <span className="font-semibold text-sm tracking-wide hidden md:inline">NEXUS</span>
      </div>
      <button onClick={onOpenPalette} title="Command palette" className="shrink-0 px-2 py-1 text-xs text-faint hover:text-[var(--text-primary)] border border-subtle rounded-md hover:border-[var(--border-strong)] transition-colors">⌘K</button>
      <div className="w-px h-5 bg-[var(--border-subtle)] mx-1 shrink-0" />

      {/* Global / cross-project links */}
      <button onClick={() => onSelectGlobal('dashboard')} className={item(view === 'dashboard')}><Gauge size={16} weight={view === 'dashboard' ? 'fill' : 'regular'} /> Dashboard</button>
      <button onClick={() => onSelectGlobal('activity')} className={item(view === 'activity')}><Pulse size={16} weight={view === 'activity' ? 'fill' : 'regular'} /> Activity</button>
      <button onClick={() => onSelectGlobal('missions')} className={item(view === 'missions')}><Rocket size={16} weight={view === 'missions' ? 'fill' : 'regular'} /> Missions</button>
      <button onClick={() => onSelectGlobal('tickets')} className={item(view === 'tickets')}><Ticket size={16} weight={view === 'tickets' ? 'fill' : 'regular'} /> Tickets</button>
      <button onClick={() => onSelectGlobal('braindump')} className={item(view === 'braindump')}><Brain size={16} weight={view === 'braindump' ? 'fill' : 'regular'} /> Braindump</button>
      <button onClick={() => onSelectGlobal('assistant')} className={item(view === 'assistant')}><ChatCircle size={16} weight={view === 'assistant' ? 'fill' : 'regular'} /> Assistant</button>

      {/* Management group, right-aligned */}
      <div className="ml-auto flex items-center gap-1.5">
        <button onClick={() => onSelectManage('settings')} className={item(view === 'settings')}><Gear size={16} /> Settings</button>
      </div>
    </header>
  );
}
