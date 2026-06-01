import { Persona } from '@nexus/shared';

interface SidebarProps {
  personas: Persona[];
  view: string;
  /** whether a project is currently active (project-scoped views need one) */
  hasProject: boolean;
  onSelectView: (v: string) => void;
  onSelectAgent: (slug: string) => void;
}

const VIEWS: { id: string; label: string; icon: string }[] = [
  { id: 'kanban', label: 'Kanban', icon: '▦' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'memory', label: 'Memory', icon: '🧠' },
  { id: 'scheduler', label: 'Scheduler', icon: '⏱' },
  { id: 'usage', label: 'Usage', icon: '📊' },
];

function GroupLabel({ children }: { children: string }) {
  return (
    <div className="px-3 pt-4 pb-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">{children}</span>
    </div>
  );
}

function NavItem({
  active,
  dimmed,
  onClick,
  icon,
  dot,
  children,
}: {
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
  icon?: string;
  dot?: boolean;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
        active ? 'bg-indigo-500/20 text-white' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/30'
      } ${dimmed ? 'opacity-50' : ''}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" title="status unknown" />}
      {icon && <span className="text-sm leading-none w-4 text-center shrink-0">{icon}</span>}
      <span className="truncate">{children}</span>
    </button>
  );
}

export default function Sidebar({ personas, view, hasProject, onSelectView, onSelectAgent }: SidebarProps) {
  return (
    <aside className="w-52 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0 overflow-y-auto">
      <GroupLabel>Views</GroupLabel>
      {VIEWS.map(v => (
        <NavItem
          key={v.id}
          active={view === v.id}
          dimmed={!hasProject}
          onClick={() => onSelectView(v.id)}
          icon={v.icon}
        >
          {v.label}
        </NavItem>
      ))}

      <GroupLabel>Agents</GroupLabel>
      {personas.map(p => (
        <NavItem
          key={p.slug}
          active={view === `agent:${p.slug}`}
          dimmed={!hasProject}
          onClick={() => onSelectAgent(p.slug)}
          dot
        >
          {p.name}
        </NavItem>
      ))}
      {personas.length === 0 && (
        <div className="px-3 py-2 text-xs text-zinc-600">No agents yet</div>
      )}

      <GroupLabel>Self</GroupLabel>
      <NavItem active={view === 'personas'} onClick={() => onSelectView('personas')} icon="👤">
        Personas
      </NavItem>
      <NavItem active={view === 'settings'} onClick={() => onSelectView('settings')} icon="⚙️">
        Settings
      </NavItem>

      <div className="mt-auto px-3 py-3 border-t border-zinc-800">
        <div className="text-[10px] text-zinc-600/50">v0.1.0 · Personal</div>
      </div>
    </aside>
  );
}
