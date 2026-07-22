import { useState, useRef, useMemo } from 'react';
import { Project, ChatThread, deriveProjectBadge } from '@nexus/shared';
import { Kanban, Brain, ChatCircle, Plus, PencilSimple, Trash, ArchiveBoxIcon, CircleNotch, GitBranch, Target } from '@phosphor-icons/react';
import { confirmDialog } from '../lib/confirm';

/** 'projectManagement' is the Monday.com initiative-level view (Task 12) —
 *  Monday items are high-level initiatives that several Kanban tasks link to. */
export type SubView = 'kanban' | 'memory' | 'chat' | 'projectManagement';

export interface ThreadMeta {
  thread: ChatThread;
}

export interface SidebarProjectCounts {
  tasks: number;
  sessions: number;
}

/**
 * What a session is doing right now. Drives one badge vocabulary shared by the
 * project rail, the per-project session rows and the Active sessions list:
 *   waiting → amber  (the model asked a question and is blocked on the user)
 *   working → red    (the model is running a turn)
 *   idle    → green  (the session is live but nothing is running)
 * Precedence is waiting > working > idle: a session needing *you* outranks one
 * that is busy on its own.
 */
export type SessionActivity = 'waiting' | 'working' | 'idle';

/** One live session, surfaced globally in the sidebar. */
export interface SidebarSession {
  threadId: string;
  title: string;
  projectId: string | null;
  activity: SessionActivity;
}

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  subView: SubView;
  activeThreadId: string | null;
  threads: ThreadMeta[];
  workingSessionIds: Set<string>;
  waitingSessionIds: Set<string>;
  workingProjectIds: Set<string>;
  waitingProjectIds: Set<string>;
  /** Projects owning at least one live session — the green rail dot. */
  liveProjectIds: Set<string>;
  /** Every live session across ALL projects, ordered most-recent first. Sessions
   *  stay listed once their run finishes and leave only on delete/archive. */
  sessions: SidebarSession[];
  archivingThreadIds: Set<string>;
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

function Row({ active, depth, onClick, icon, children, tintColor, trailing, draggable, onDragStart, onDragOver, onDrop, className = '' }: {
  active: boolean; depth: number; onClick: () => void; icon?: React.ReactNode;
  children: React.ReactNode; tintColor?: string; trailing?: React.ReactNode;
  draggable?: boolean;
  onDragStart?: (ev: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (ev: React.DragEvent<HTMLButtonElement>) => void;
  onDrop?: (ev: React.DragEvent<HTMLButtonElement>) => void;
  className?: string;
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
      } ${className}`}
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

function BranchIcon({ branch }: { branch?: string }) {
  const label = branch ? `Branch: ${branch}` : 'Branch unavailable';
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex h-4 w-4 items-center justify-center ${branch ? 'accent-text' : 'text-faint'}`}
    >
      <GitBranch size={14} weight="bold" aria-hidden="true" />
    </span>
  );
}

/**
 * Stored badge, falling back to the derived one. The migration backfills every
 * row, so the fallback only fires on version skew — a thin client talking to a
 * server that predates the badge column (see #164) sends no badge at all.
 */
function projectBadge(project: Project): string {
  return project.badge || deriveProjectBadge(project.name);
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Badge colour per activity. Only the two states that are changing pulse —
 *  idle is a resting light, so it stays still and doesn't compete for attention. */
const ACTIVITY_DOT: Record<SessionActivity, string> = {
  waiting: 'bg-amber-400 animate-pulse',
  working: 'bg-red-500 animate-pulse',
  idle: 'bg-emerald-400',
};

const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  waiting: 'waiting for input',
  working: 'model working',
  idle: 'idle',
};

const ACTIVITY_PILL: Record<SessionActivity, { className: string; text: string }> = {
  waiting: { className: 'compact-session-status-wait', text: 'WAIT' },
  working: { className: 'compact-session-status-work', text: 'RUN' },
  idle: { className: 'compact-session-status-idle', text: 'IDLE' },
};

/** waiting > working > idle, so the list surfaces what needs the user first. */
const ACTIVITY_RANK: Record<SessionActivity, number> = { waiting: 0, working: 1, idle: 2 };

export default function Sidebar({
  projects, activeProjectId, subView, activeThreadId, threads, workingSessionIds,
  waitingSessionIds, workingProjectIds, waitingProjectIds, liveProjectIds, sessions,
  archivingThreadIds,
  projectCounts,
  onSelectProject, onSelectSubView, onSelectThread, onRenameThread, onArchiveThread, onDeleteThread, onNewChat, onNewProject,
  onEditProject, onDeleteProject, onReorderProjects,
}: SidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Sessions arrive most-recent first; lift the ones needing attention to the top
  // without disturbing recency within each band.
  const orderedSessions = useMemo(
    () => [...sessions].sort((a, b) => ACTIVITY_RANK[a.activity] - ACTIVITY_RANK[b.activity]),
    [sessions],
  );

  const startRename = (id: string, current: string) => { setRenamingId(id); setRenameDraft(current); };
  const cancelRename = () => { setRenamingId(null); setRenameDraft(''); };
  const commitRename = (id: string) => {
    const trimmed = renameDraft.trim();
    if (trimmed) onRenameThread(id, trimmed);
    cancelRename();
  };

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeProjectCounts = activeProject ? projectCounts[activeProject.id] ?? { tasks: 0, sessions: 0 } : null;

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
      className="relative surface-glass border-r border-subtle flex shrink-0 overflow-hidden"
    >
      <nav aria-label="Project rail" className="compact-project-rail w-14 shrink-0 px-2 py-3 flex flex-col items-center gap-2">
        {projects.map((project) => {
          const isActiveProject = project.id === activeProjectId;
          const activity: SessionActivity | null = waitingProjectIds.has(project.id)
            ? 'waiting'
            : workingProjectIds.has(project.id)
              ? 'working'
              : liveProjectIds.has(project.id)
                ? 'idle'
                : null;
          return (
            <button
              key={project.id}
              type="button"
              title={project.name}
              aria-label={`Switch to ${project.name}`}
              onClick={() => onSelectProject(project.id)}
              draggable
              onDragStart={(ev) => handleProjectDragStart(ev, project.id)}
              onDragOver={handleProjectDragOver}
              onDrop={(ev) => handleProjectDrop(ev, project.id)}
              className={`compact-project-avatar relative grid place-items-center h-10 w-10 text-xs tracking-tight ${
                isActiveProject
                  ? 'compact-project-avatar-active'
                  : 'text-muted hover:text-[var(--text-primary)]'
              }`}
            >
              {projectBadge(project)}
              {activity && (
                <span
                  title={`${project.name}: ${ACTIVITY_LABEL[activity]}`}
                  aria-label={`${project.name}: ${ACTIVITY_LABEL[activity]}`}
                  /* Sits on the badge's corner rather than inside it — a 3-char
                     badge fills the box that a single initial left empty. */
                  className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-[var(--bg-canvas)] ${ACTIVITY_DOT[activity]}`}
                />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onNewProject}
          title="New project"
          className="compact-project-avatar mt-2 h-10 w-10 text-faint hover:text-[var(--text-primary)] grid place-items-center"
        >
          <Plus size={17} />
        </button>
      </nav>

      <div aria-label="Project details" className="compact-project-panel min-w-0 flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-3 pt-3 pb-2">
          <div className="flex items-center justify-between pb-2">
            <span className="text-[10px] uppercase tracking-wider text-faint font-medium">Projects</span>
            <button onClick={onNewProject} title="New project" className="text-faint hover:text-[var(--text-primary)] cursor-pointer">
              <Plus size={14} />
            </button>
          </div>

          {activeProject && activeProjectCounts && (
            <div
              aria-label={`Active project: ${activeProject.name}`}
              className="compact-project-card surface-elevated rounded-xl px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-primary">{activeProject.name}</div>
                  <div className="mt-1 truncate text-xs text-faint">{activeProject.repo_path || 'No path set'}</div>
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-bold accent-text">
                    Active
                  </span>
                  <button
                    type="button"
                    title="Edit active project"
                    aria-label="Edit active project"
                    onClick={() => onEditProject(activeProject)}
                    className="compact-project-action"
                  >
                    <PencilSimple size={13} />
                  </button>
                  <button
                    type="button"
                    title="Delete active project"
                    aria-label="Delete active project"
                    onClick={async () => {
                      if (await confirmDialog('Delete this project? This cannot be undone.')) onDeleteProject(activeProject.id);
                    }}
                    className="compact-project-action hover:text-red-400"
                  >
                    <Trash size={13} />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="rounded-full border border-subtle px-2 py-0.5 text-[10px] font-semibold text-muted">
                  {pluralize(activeProjectCounts.tasks, 'task')}
                </span>
                <span className="rounded-full border border-subtle px-2 py-0.5 text-[10px] font-semibold text-muted">
                  {pluralize(activeProjectCounts.sessions, 'session')}
                </span>
              </div>
            </div>
          )}
        </div>

        {activeProject && activeProjectCounts ? (
          <section aria-label="Active project workspace" className="px-3 pb-2 space-y-2">
            <div className="compact-project-workspace" aria-label="Active project navigation">
              <Row
                active={subView === 'kanban'}
                depth={0}
                onClick={() => onSelectSubView(activeProject.id, 'kanban')}
                icon={<Kanban size={15} />}
                trailing={<CountBadge>{activeProjectCounts.tasks}</CountBadge>}
              >
                Kanban
              </Row>
              <Row
                active={subView === 'memory'}
                depth={0}
                onClick={() => onSelectSubView(activeProject.id, 'memory')}
                icon={<Brain size={15} />}
              >
                Memory
              </Row>
              <Row
                active={subView === 'projectManagement'}
                depth={0}
                onClick={() => onSelectSubView(activeProject.id, 'projectManagement')}
                icon={<Target size={15} />}
              >
                Project Management
              </Row>
              <Row
                active={false}
                depth={0}
                onClick={() => onNewChat(activeProject.id)}
                icon={<ChatCircle size={15} />}
                trailing={
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent-soft)] text-base leading-none accent-text group-hover:bg-[rgba(125,244,201,0.20)]">
                    <Plus size={14} />
                  </span>
                }
              >
                New Session
              </Row>
            </div>

            <section aria-label="Project sessions" className="space-y-1.5">
                <>
                  {threads.map(({ thread }) => {
                          const isRenaming = renamingId === thread.id;
                          const isArchiving = archivingThreadIds.has(thread.id);
                          // Every listed thread is live by definition (archived ones
                          // are filtered out server-side), so it always has a badge.
                          const activity: SessionActivity = waitingSessionIds.has(thread.id)
                            ? 'waiting'
                            : workingSessionIds.has(thread.id)
                              ? 'working'
                              : 'idle';
                          return (
                            <Row
                              key={thread.id}
                              active={activeThreadId === thread.id}
                              depth={0}
                              icon={<BranchIcon branch={thread.git_branch} />}
                              className="compact-project-session-row"
                              onClick={() => {
                                if (!isRenaming && !isArchiving) onSelectThread(activeProject.id, thread.id);
                              }}
                              trailing={
                                <span className="flex items-center gap-1 shrink-0">
                                  {isArchiving ? (
                                    <span
                                      title="Archiving to memory"
                                      className="inline-flex items-center gap-1 text-[10px] text-emerald-300"
                                    >
                                      <CircleNotch size={13} className="animate-spin" />
                                      <span>Archiving...</span>
                                    </span>
                                  ) : (
                                    <span
                                      title={`Session ${ACTIVITY_LABEL[activity]}`}
                                      aria-label={`Session ${ACTIVITY_LABEL[activity]}`}
                                      className={`inline-block h-2.5 w-2.5 rounded-full ${ACTIVITY_DOT[activity]}`}
                                    />
                                  )}
                                  {!isArchiving && (
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
                                      onClick={async (ev) => {
                                        ev.stopPropagation();
                                        if (await confirmDialog('Archive this session to memory and delete it?')) onArchiveThread(thread.id);
                                      }}
                                    >
                                      <ArchiveBoxIcon size={13} />
                                    </span>
                                    <span
                                      role="button"
                                      title="Delete"
                                      className="text-faint hover:text-red-400"
                                      onClick={async (ev) => {
                                        ev.stopPropagation();
                                        if (await confirmDialog('Delete this session? This cannot be undone.')) onDeleteThread(thread.id);
                                      }}
                                    >
                                      <Trash size={13} />
                                    </span>
                                  </span>
                                  )}
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
                                  className="w-full surface-elevated text-primary text-sm px-1 py-0.5 rounded-sm outline-hidden ring-1 ring-[var(--accent)]"
                                />
                              ) : (
                                thread.title
                              )}
                            </Row>
                          );
                        })}
                  {threads.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-faint">No sessions</div>
                  )}
                </>
              </section>
          </section>
        ) : (
          <div className="px-3 py-2 text-xs text-faint">No projects yet</div>
        )}
        </div>

        {orderedSessions.length > 0 && (
          <section aria-label="Active sessions" className="flex min-h-0 flex-col px-3 pt-3 pb-2 border-t border-subtle">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-faint font-medium">Active sessions</span>
              <CountBadge>{orderedSessions.length}</CountBadge>
            </div>
            {/* Grows with its sessions and only scrolls when the sidebar runs out of room. */}
            <div className="min-h-0 space-y-1.5 overflow-y-auto">
              {orderedSessions.map((session) => {
                const sessionProject = projects.find((p) => p.id === session.projectId);
                const pill = ACTIVITY_PILL[session.activity];
                return (
                  <button
                    type="button"
                    key={session.threadId}
                    onClick={() => { if (session.projectId) onSelectThread(session.projectId, session.threadId); }}
                    className="compact-session-card group w-full px-2.5 py-2 text-left transition-colors cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-semibold text-primary">{session.title}</span>
                      <span className={`compact-session-status shrink-0 ${pill.className}`}>{pill.text}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-faint truncate">{sessionProject?.name ?? 'Unknown project'}</div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <div className="px-3 py-3 border-t border-subtle">
          <div className="text-[10px] text-faint">v0.1.0 · Personal</div>
        </div>
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
