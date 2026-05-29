import { Project } from '@nexus/shared';

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeGlobalView: 'personas' | 'settings' | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onSelectPersonas: () => void;
  onSelectSettings: () => void;
}

export default function Sidebar({ projects, activeProjectId, activeGlobalView, onSelectProject, onNewProject, onSelectPersonas, onSelectSettings }: SidebarProps) {
  return (
    <aside className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
      <div className="px-4 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-indigo-500 flex items-center justify-center text-white text-xs font-bold">N</div>
          <span className="font-semibold text-sm tracking-wide">NEXUS</span>
        </div>
      </div>

      <div className="px-3 pt-3 pb-2 space-y-1">
        <button
          onClick={onSelectPersonas}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeGlobalView === 'personas' ? 'bg-indigo-500/20 text-white' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/30'}`}
        >
          <span className="text-base">👤</span>
          <span>Personas</span>
        </button>
        <button
          onClick={onSelectSettings}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${activeGlobalView === 'settings' ? 'bg-indigo-500/20 text-white' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/30'}`}
        >
          <span className="text-base">⚙️</span>
          <span>Settings</span>
        </button>
      </div>

      <div className="h-px bg-zinc-800 mx-3" />

      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-3 mb-2">
          <button
            onClick={onNewProject}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 rounded-md transition-colors"
          >
            <span className="text-lg leading-none">+</span>
            <span>New Project</span>
          </button>
        </div>

        <div className="px-3 mb-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Projects</span>
        </div>

        {projects.map(project => (
          <button
            key={project.id}
            onClick={() => onSelectProject(project.id)}
            className={`w-full text-left px-3 py-2 mx-1 rounded-md text-sm transition-colors ${activeProjectId === project.id ? 'bg-indigo-500/20 text-white' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/30'}`}
          >
            <div className="truncate">{project.name}</div>
          </button>
        ))}

        {projects.length === 0 && (
          <div className="px-3 py-4 text-xs text-zinc-500 text-center">
            No projects yet
          </div>
        )}
      </div>

      <div className="px-3 py-3 border-t border-zinc-800">
        <div className="text-[10px] text-zinc-600/50">v0.1.0 · Personal</div>
      </div>
    </aside>
  );
}
