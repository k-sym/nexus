import { useState } from 'react';
import { Project, ChatThread } from '@nexus/shared';
import { CaretRight, CaretDown, Kanban, Brain, ChatCircle, Plus } from '@phosphor-icons/react';
import { PersonaIcon } from '../personaIcons';

export type SubView = 'kanban' | 'memory' | 'chat';

export interface ThreadMeta {
  thread: ChatThread;
  icon?: string;
  color: string;
}

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  subView: SubView;
  activeThreadId: string | null;
  /** threads for the active project, keyed for the open Chat accordion (with persona visuals resolved) */
  threads: ThreadMeta[];
  onSelectProject: (id: string) => void;
  onSelectSubView: (projectId: string, sub: SubView) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onNewChat: (projectId: string, anchor: HTMLElement) => void;
  onNewProject: () => void;
}

function Row({ active, depth, onClick, icon, children, tintColor, trailing }: {
  active: boolean; depth: number; onClick: () => void; icon?: React.ReactNode;
  children: React.ReactNode; tintColor?: string; trailing?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{ paddingLeft: 8 + depth * 14, borderLeft: tintColor ? `2px solid ${tintColor}` : '2px solid transparent' }}
      className={`group w-full flex items-center gap-2 pr-2 py-1.5 text-sm transition-colors ${
        active ? 'bg-indigo-500/20 text-white' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/30'
      }`}
    >
      {icon && <span className="shrink-0 flex items-center w-4">{icon}</span>}
      <span className="truncate flex-1 text-left">{children}</span>
      {trailing}
    </button>
  );
}

export default function Sidebar({
  projects, activeProjectId, subView, activeThreadId, threads,
  onSelectProject, onSelectSubView, onSelectThread, onNewChat, onNewProject,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string) => expanded[id] ?? (id === activeProjectId);

  return (
    <aside className="w-60 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0 overflow-y-auto">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Projects</span>
        <button onClick={onNewProject} title="New project" className="text-zinc-500 hover:text-zinc-200"><Plus size={14} /></button>
      </div>

      {projects.map(project => {
        const open = isExpanded(project.id);
        const isActiveProject = project.id === activeProjectId;
        const chatExpanded = chatOpen[project.id] ?? false;
        return (
          <div key={project.id}>
            <Row
              active={isActiveProject && false}
              depth={0}
              onClick={() => { setExpanded(e => ({ ...e, [project.id]: !open })); onSelectProject(project.id); }}
              icon={open ? <CaretDown size={14} /> : <CaretRight size={14} />}
            >
              <span className="font-medium text-zinc-200 truncate">{project.name}</span>
            </Row>

            {open && (
              <>
                <Row active={isActiveProject && subView === 'kanban'} depth={1} onClick={() => onSelectSubView(project.id, 'kanban')} icon={<Kanban size={15} />}>Kanban</Row>
                <Row active={isActiveProject && subView === 'memory'} depth={1} onClick={() => onSelectSubView(project.id, 'memory')} icon={<Brain size={15} />}>Memory</Row>
                <Row
                  active={isActiveProject && subView === 'chat' && !activeThreadId}
                  depth={1}
                  onClick={() => { setChatOpen(c => ({ ...c, [project.id]: !chatExpanded })); onSelectSubView(project.id, 'chat'); }}
                  icon={<ChatCircle size={15} />}
                  trailing={chatExpanded ? <CaretDown size={12} className="text-zinc-600" /> : <CaretRight size={12} className="text-zinc-600" />}
                >
                  Chat
                </Row>

                {chatExpanded && (
                  <>
                    <Row
                      active={false}
                      depth={2}
                      onClick={(() => {}) as never}
                      icon={<Plus size={14} />}
                    >
                      <span
                        onClick={ev => { ev.stopPropagation(); onNewChat(project.id, ev.currentTarget.parentElement as HTMLElement); }}
                        className="text-indigo-400"
                      >
                        New
                      </span>
                    </Row>
                    {isActiveProject && threads.map(({ thread, icon, color }) => (
                      <Row
                        key={thread.id}
                        active={activeThreadId === thread.id}
                        depth={2}
                        tintColor={color}
                        onClick={() => onSelectThread(project.id, thread.id)}
                        icon={<PersonaIcon icon={icon} color={color} size={14} />}
                      >
                        {thread.title}
                      </Row>
                    ))}
                    {isActiveProject && threads.length === 0 && (
                      <div className="pl-12 py-1.5 text-xs text-zinc-600">No conversations</div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
      {projects.length === 0 && <div className="px-3 py-2 text-xs text-zinc-600">No projects yet</div>}

      <div className="mt-auto px-3 py-3 border-t border-zinc-800">
        <div className="text-[10px] text-zinc-600/50">v0.1.0 · Personal</div>
      </div>
    </aside>
  );
}
