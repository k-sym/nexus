import { useState, useEffect, useRef } from 'react';
import { Project, ChatThread } from '@nexus/shared';
import { CaretRight, CaretDown, Kanban, Brain, ChatCircle, Plus, PencilSimple, Trash, ArchiveBoxIcon } from '@phosphor-icons/react';

export type SubView = 'kanban' | 'memory' | 'chat';

export interface ThreadMeta {
  thread: ChatThread;
}

export interface SidebarProjectCounts {
  tasks: number;
  sessions: number;
}

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  subView: SubView;
  activeThreadId: string | null;
  threads: ThreadMeta[];
  activeSessionIds: Set<string>;
  projectCounts: Record<string, SidebarProjectCounts>;
  onSelectProject: (id: string) => void;
  onSelectSubView: (projectId: string, sub: SubView) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onArchiveThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onNewChat: (projectId: string) => void;
  onNewProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onReorderProjects: (projectIds: string[]) => void;
}

const SIDEBAR_WIDTH_KEY = 'nexus.sidebar.width';
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 360;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function readSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function Row({ active, depth, onClick, icon, children, tintColor, trailing, draggable, onDragStart, onDragOver, onDrop }: {
  active: boolean; depth: number; onClick: () => void; icon?: React.ReactNode;
  children: React.ReactNode; tintColor?: string; trailing?: React.ReactNode;
  draggable?: boolean;
  onDragStart?: (ev: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (ev: React.DragEvent<HTMLButtonElement>) => void;
  onDrop?: (ev: React.DragEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ paddingLeft: 8 + depth * 14, borderLeft: tintColor ? `2px solid ${tintColor}` : '2px solid transparent' }}
      className={`group w-full flex items-center gap-2 pr-2 py-1.5 text-sm transition-colors ${
        active ? 'surface-active text-primary' : 'text-muted hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      {icon && <span className="shrink-0 flex items-center w-4">{icon}</span>}
      <span className="truncate flex-1 text-left">{children}</span>
      {trailing}
    </button>
  );
}

function CountBadge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`shrink-0 tabular-nums text-[11px] font-semibold accent-text ${className}`}>
      {children}
    </span>
  );
}

export default function Sidebar({
  projects, activeProjectId, subView, activeThreadId, threads, activeSessionIds,
  projectCounts,
  onSelectProject, onSelectSubView, onSelectThread, onRenameThread, onArchiveThread, onDeleteThread, onNewChat, onNewProject,
  onEditProject, onDeleteProject, onReorderProjects,
}: SidebarProps) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(activeProjectId);
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => { if (activeProjectId) setOpenProjectId(activeProjectId); }, [activeProjectId]);

  const startRename = (id: string, current: string) => { setRenamingId(id); setRenameDraft(current); };
  const cancelRename = () => { setRenamingId(null); setRenameDraft(''); };
  const commitRename = (id: string) => {
    const trimmed = renameDraft.trim();
    if (trimmed) onRenameThread(id, trimmed);
    cancelRename();
  };

  const handleProjectDragStart = (ev: React.DragEvent<HTMLButtonElement>, projectId: string) => {
    ev.dataTransfer.setData('application/x-nexus-project-id', projectId);
    ev.dataTransfer.effectAllowed = 'move';
  };

  const handleProjectDragOver = (ev: React.DragEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
  };

  const handleProjectDrop = (ev: React.DragEvent<HTMLButtonElement>, targetProjectId: string) => {
    ev.preventDefault();
    const draggedProjectId = ev.dataTransfer.getData('application/x-nexus-project-id');
    if (!draggedProjectId || draggedProjectId === targetProjectId) return;

    const orderedIds = projects.map((project) => project.id);
    const fromIndex = orderedIds.indexOf(draggedProjectId);
    const toIndex = orderedIds.indexOf(targetProjectId);
    if (fromIndex === -1 || toIndex === -1) return;

    orderedIds.splice(fromIndex, 1);
    orderedIds.splice(toIndex, 0, draggedProjectId);
    onReorderProjects(orderedIds);
  };

  const startResize = (ev: React.PointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    dragStartRef.current = { startX: ev.clientX, startWidth: sidebarWidth };

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (moveEv: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const nextWidth = clampSidebarWidth(start.startWidth + moveEv.clientX - start.startX);
      setSidebarWidth(nextWidth);
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth)); } catch { /* ignore */ }
    };

    const onUp = () => {
      dragStartRef.current = null;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <aside
      aria-label="Navigation sidebar"
      style={{ width: `${sidebarWidth}px` }}
      className="relative surface-glass border-r border-subtle flex flex-col shrink-0 overflow-y-auto"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-faint font-medium">Projects</span>
        <button onClick={onNewProject} title="New project" className="text-faint hover:text-[var(--text-primary)]">
          <Plus size={14} />
        </button>
      </div>

      {projects.map((project) => {
        const open = openProjectId === project.id;
        const isActiveProject = project.id === activeProjectId;
        const chatExpanded = chatOpen[project.id] ?? (isActiveProject && subView === 'chat');
        const counts = projectCounts[project.id] ?? { tasks: 0, sessions: 0 };
        return (
          <div key={project.id}>
            <Row
              active={false}
              depth={0}
              onClick={() => { setOpenProjectId(open ? null : project.id); onSelectProject(project.id); }}
              icon={open ? <CaretDown size={14} /> : <CaretRight size={14} />}
              draggable
              onDragStart={(ev) => handleProjectDragStart(ev, project.id)}
              onDragOver={handleProjectDragOver}
              onDrop={(ev) => handleProjectDrop(ev, project.id)}
              trailing={
                <span className="flex items-center gap-1.5 shrink-0">
                  <CountBadge className="group-hover:hidden">{counts.tasks}/{counts.sessions}</CountBadge>
                  <span className="hidden group-hover:flex items-center gap-1">
                    <span
                      role="button"
                      title="Edit project"
                      className="text-faint hover:text-[var(--text-primary)]"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onEditProject(project);
                      }}
                    >
                      <PencilSimple size={13} />
                    </span>
                    <span
                      role="button"
                      title="Delete project"
                      className="text-faint hover:text-red-400"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (window.confirm('Delete this project? This cannot be undone.')) onDeleteProject(project.id);
                      }}
                    >
                      <Trash size={13} />
                    </span>
                  </span>
                </span>
              }
            >
              <span className="font-medium text-primary truncate">{project.name}</span>
            </Row>

            {open && (
              <>
                <Row
                  active={isActiveProject && subView === 'kanban'}
                  depth={1}
                  onClick={() => onSelectSubView(project.id, 'kanban')}
                  icon={<Kanban size={15} />}
                  trailing={<CountBadge>{counts.tasks}</CountBadge>}
                >
                  Kanban
                </Row>
                <Row
                  active={isActiveProject && subView === 'memory'}
                  depth={1}
                  onClick={() => onSelectSubView(project.id, 'memory')}
                  icon={<Brain size={15} />}
                >
                  Memory
                </Row>
                <Row
                  active={isActiveProject && subView === 'chat' && !activeThreadId}
                  depth={1}
                  onClick={() => {
                    setChatOpen((c) => ({ ...c, [project.id]: !chatExpanded }));
                    onSelectSubView(project.id, 'chat');
                  }}
                  icon={<ChatCircle size={15} />}
                  trailing={
                    <span className="flex items-center gap-1.5 shrink-0">
                      <CountBadge>{counts.sessions}</CountBadge>
                      {chatExpanded ? (
                        <CaretDown size={12} className="text-faint" />
                      ) : (
                        <CaretRight size={12} className="text-faint" />
                      )}
                    </span>
                  }
                >
                  Sessions
                </Row>

                {chatExpanded && (
                  <>
                    <Row
                      active={false}
                      depth={2}
                      onClick={() => onNewChat(project.id)}
                      icon={<Plus size={14} />}
                    >
                      <span className="accent-text">New Session</span>
                    </Row>
                    {isActiveProject &&
                      threads.map(({ thread }) => {
                        const isRenaming = renamingId === thread.id;
                        const isActiveSession = activeSessionIds.has(thread.id);
                        return (
                          <Row
                            key={thread.id}
                            active={activeThreadId === thread.id}
                            depth={2}
                            onClick={() => {
                              if (!isRenaming) onSelectThread(project.id, thread.id);
                            }}
                            trailing={
                              <span className="flex items-center gap-1 shrink-0">
                                {isActiveSession && (
                                  <span
                                    title="Session active"
                                    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent-strong)] animate-spin"
                                  />
                                )}
                                <span className="hidden group-hover:flex items-center gap-1">
                                  <span
                                    role="button"
                                    title="Rename"
                                    className="text-faint hover:text-[var(--text-primary)]"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      startRename(thread.id, thread.title);
                                    }}
                                  >
                                    <PencilSimple size={13} />
                                  </span>
                                  <span
                                    role="button"
                                    title="Archive to memory"
                                    className="text-faint hover:text-[var(--text-primary)]"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      if (window.confirm('Archive this session to memory and delete it?')) onArchiveThread(thread.id);
                                    }}
                                  >
                                    <ArchiveBoxIcon size={13} />
                                  </span>
                                  <span
                                    role="button"
                                    title="Delete"
                                    className="text-faint hover:text-red-400"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      if (window.confirm('Delete this session? This cannot be undone.')) onDeleteThread(thread.id);
                                    }}
                                  >
                                    <Trash size={13} />
                                  </span>
                                </span>
                              </span>
                            }
                          >
                            {isRenaming ? (
                              <input
                                autoFocus
                                value={renameDraft}
                                onClick={(ev) => ev.stopPropagation()}
                                onChange={(ev) => setRenameDraft(ev.target.value)}
                                onBlur={() => commitRename(thread.id)}
                                onKeyDown={(ev) => {
                                  if (ev.key === 'Enter') { ev.preventDefault(); commitRename(thread.id); }
                                  else if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
                                }}
                                className="w-full surface-elevated text-primary text-sm px-1 py-0.5 rounded outline-none ring-1 ring-[var(--accent)]"
                              />
                            ) : (
                              thread.title
                            )}
                          </Row>
                        );
                      })}
                    {isActiveProject && threads.length === 0 && (
                      <div className="pl-12 py-1.5 text-xs text-faint">No sessions</div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
      {projects.length === 0 && <div className="px-3 py-2 text-xs text-faint">No projects yet</div>}

      <div className="mt-auto px-3 py-3 border-t border-subtle">
        <div className="text-[10px] text-faint">v0.1.0 · Personal</div>
      </div>
      <div
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        title="Drag to resize sidebar"
        onPointerDown={startResize}
        className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--accent-soft)]"
      />
    </aside>
  );
}
