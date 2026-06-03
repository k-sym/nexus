import { Project } from '@nexus/shared';
import { Gauge, Ticket } from '@phosphor-icons/react';

interface TopBarProps {
  projects: Project[];
  activeProjectId: string | null;
  /** true when the current view is a global (project-less) view */
  isGlobal: boolean;
  view: string;
  onSelectGlobal: (v: 'mission-control' | 'tickets') => void;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onOpenPalette: () => void;
}

const base = 'shrink-0 px-3 py-1 text-sm rounded-md transition-colors whitespace-nowrap';
const pin = (active: boolean) =>
  `${base} ${active ? 'bg-indigo-500 text-ink' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'}`;
const tab = (active: boolean) =>
  `${base} ${active ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/30'}`;

export default function TopBar({
  projects,
  activeProjectId,
  isGlobal,
  view,
  onSelectGlobal,
  onSelectProject,
  onNewProject,
  onOpenPalette,
}: TopBarProps) {
  return (
    <header className="h-12 shrink-0 flex items-center gap-1.5 px-3 border-b border-zinc-800 bg-zinc-900">
      {/* Brand */}
      <div className="flex items-center gap-2 pr-1">
        <div className="w-6 h-6 rounded bg-indigo-500 flex items-center justify-center text-ink text-[11px] font-bold">N</div>
        <span className="font-semibold text-sm tracking-wide hidden md:inline">NEXUS</span>
      </div>

      {/* Command palette (wired in a later step) */}
      <button
        onClick={onOpenPalette}
        title="Command palette (coming soon)"
        className="shrink-0 flex items-center gap-1.5 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors"
      >
        ⌘K
      </button>

      <div className="w-px h-5 bg-zinc-800 mx-1 shrink-0" />

      {/* Global pins */}
      <button onClick={() => onSelectGlobal('mission-control')} className={`${pin(view === 'mission-control')} flex items-center gap-1.5`}>
        <Gauge size={16} weight={view === 'mission-control' ? 'fill' : 'regular'} /> Mission Control
      </button>
      <button onClick={() => onSelectGlobal('tickets')} className={`${pin(view === 'tickets')} flex items-center gap-1.5`}>
        <Ticket size={16} weight={view === 'tickets' ? 'fill' : 'regular'} /> Tickets
      </button>

      <div className="w-px h-5 bg-zinc-800 mx-1 shrink-0" />

      {/* Project tabs (recents strip) */}
      <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
        {projects.map(p => (
          <button
            key={p.id}
            onClick={() => onSelectProject(p.id)}
            title={p.repo_path}
            className={tab(!isGlobal && activeProjectId === p.id)}
          >
            {p.name}
          </button>
        ))}
        {projects.length === 0 && (
          <span className="px-2 text-xs text-zinc-600">No projects yet</span>
        )}
      </div>

      <button
        onClick={onNewProject}
        className="shrink-0 px-2.5 py-1 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50 rounded-md transition-colors"
      >
        + New
      </button>
    </header>
  );
}
