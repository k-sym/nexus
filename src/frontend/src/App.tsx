import { useState, useEffect, useCallback, useMemo } from 'react';
import { Project, Task, Persona, Ticket, ChatThread, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, TaskStatus, DEFAULT_PERSONA_COLOR } from '@nexus/shared';
import { api, MissionStatus } from './api';
import TopBar from './components/TopBar';
import CommandPalette, { Command } from './components/CommandPalette';
import Sidebar, { SubView, ThreadMeta } from './components/Sidebar';
import MissionControl from './components/MissionControl';
import TicketsView from './components/TicketsView';
import DaemonToasts from './components/DaemonToasts';
import NotificationToasts from './components/NotificationToasts';
import KanbanBoard from './components/KanbanBoard';
import ChatPanel from './components/ChatPanel';
import MemoryView from './components/MemoryView';
import PersonasPage from './components/PersonasPage';
import SchedulerPage from './components/SchedulerPage';
import SettingsPage from './components/SettingsPage';
import UsagePage from './components/UsagePage';
import ProjectModal from './components/ProjectModal';
import TaskModal from './components/TaskModal';
import ColumnAgentMapping from './components/ColumnAgentMapping';
import OpenCodeModelsView from './components/OpenCodeModelsView';
import NewChatPicker from './components/NewChatPicker';

// Top-bar destinations: cross-project globals + the management group. `null`
// means a project is focused (project-scoped `subView` drives the main area).
type GlobalView = 'dashboard' | 'tickets' | 'scheduler' | 'usage' | 'personas' | 'opencode-models' | 'settings';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [taskModalColumn, setTaskModalColumn] = useState<TaskStatus | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<MissionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // --- navigation state -----------------------------------------------------
  const [globalView, setGlobalView] = useState<GlobalView | null>('dashboard'); // null = a project is focused
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [subView, setSubView] = useState<SubView>('kanban');
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [newChat, setNewChat] = useState<{ projectId: string } | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      setStatus(await api.missionControl.get());
    } catch (err) {
      console.error('Failed to load status:', err);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 15000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const data = await api.projects.list();
      setProjects(data);
      return data;
    } catch (err) {
      console.error('Failed to load projects:', err);
      return [];
    }
  }, []);

  const loadTasks = useCallback(async (projectId: string) => {
    try {
      const data = await api.projects.tasks(projectId);
      setTasks(data);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  }, []);

  const loadThreads = useCallback(async (projectId: string) => {
    try { setThreads(await api.chat.threads(projectId)); }
    catch (err) { console.error('Failed to load threads:', err); }
  }, []);

  useEffect(() => {
    refreshProjects();
    api.personas.list().then(setPersonas).catch(err => console.error('Failed to load personas:', err));
  }, [refreshProjects]);

  useEffect(() => {
    if (activeProjectId) {
      const proj = projects.find(p => p.id === activeProjectId);
      setActiveProject(proj || null);
      loadTasks(activeProjectId);
    } else {
      setActiveProject(null);
      setTasks([]);
    }
  }, [activeProjectId, projects, loadTasks]);

  useEffect(() => {
    if (activeProjectId) loadThreads(activeProjectId);
    else setThreads([]);
  }, [activeProjectId, loadThreads]);

  useEffect(() => {
    if (!activeProjectId) return;
    const interval = setInterval(() => {
      if (activeProjectId) loadTasks(activeProjectId);
    }, 5000);
    return () => clearInterval(interval);
  }, [activeProjectId, loadTasks]);

  // Resolve persona visuals (icon/color) for the active project's threads — the
  // tree owns the thread list now. `status.agents` carry icon/color (Task 3).
  const threadMetas: ThreadMeta[] = useMemo(() => threads.map(t => {
    const agent = status?.agents.find(a => a.slug === t.agent_id);
    return { thread: t, icon: agent?.icon, color: agent?.color ?? DEFAULT_PERSONA_COLOR };
  }), [threads, status]);

  const activeThreadAgentSlug = useMemo(
    () => threads.find(t => t.id === activeThreadId)?.agent_id,
    [threads, activeThreadId],
  );

  const handleCreateProject = async (data: { name: string; description: string; repo_path: string }) => {
    const created = await api.projects.create(data);
    setShowProjectModal(false);
    await refreshProjects();
    selectSubView(created.id, 'kanban');
  };

  const handleCreateTask = async (data: { title: string; description: string; priority: string }) => {
    if (!activeProjectId || !taskModalColumn) return;
    await api.projects.createTask(activeProjectId, { ...data, status: taskModalColumn });
    setTaskModalColumn(null);
    await loadTasks(activeProjectId);
  };

  const handleMoveTask = async (taskId: string, newStatus: TaskStatus) => {
    await api.tasks.update(taskId, { status: newStatus });
    if (activeProjectId) await loadTasks(activeProjectId);
  };

  const handleDeleteTask = async (taskId: string) => {
    await api.tasks.delete(taskId);
    if (activeProjectId) await loadTasks(activeProjectId);
  };

  const handleCreateTaskFromTicket = async (projectId: string, ticket: Ticket) => {
    const p = (ticket.priority || '').toLowerCase();
    const priority = ['low', 'medium', 'high', 'urgent'].includes(p) ? p : 'medium';
    await api.projects.createTask(projectId, {
      title: `[${ticket.key}] ${ticket.summary}`,
      description: `From Jira ${ticket.key}${ticket.url ? ` (${ticket.url})` : ''}\n\n${ticket.summary}`,
      status: 'triage',
      priority,
    });
    if (projectId === activeProjectId) await loadTasks(projectId);
  };

  const handleProjectUpdate = (updated: Project) => {
    setProjects(prev => prev.map(p => (p.id === updated.id ? updated : p)));
    if (updated.id === activeProjectId) setActiveProject(updated);
  };

  // --- navigation helpers ---------------------------------------------------
  const selectGlobal = (v: GlobalView) => { setGlobalView(v); setActiveThreadId(null); };
  const focusProject = (id: string) => { setGlobalView(null); setActiveProjectId(id); };
  const selectSubView = (projectId: string, sub: SubView) => {
    setGlobalView(null);
    setActiveProjectId(projectId);
    setSubView(sub);
    if (sub !== 'chat') setActiveThreadId(null);
  };
  const selectThread = (projectId: string, threadId: string) => {
    setGlobalView(null);
    setActiveProjectId(projectId);
    setSubView('chat');
    setActiveThreadId(threadId);
  };

  const startNewChat = async (slug: string) => {
    if (!newChat) return;
    const thread = await api.chat.createThread(newChat.projectId, slug);
    setNewChat(null);
    await loadThreads(newChat.projectId);
    selectThread(newChat.projectId, thread.id);
  };

  // --- command palette entries ---------------------------------------------
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: 'view-dashboard', label: 'Dashboard', hint: 'View', keywords: 'mission control', run: () => selectGlobal('dashboard') },
      { id: 'view-tickets', label: 'Tickets', hint: 'View', run: () => selectGlobal('tickets') },
      { id: 'view-scheduler', label: 'Scheduler', hint: 'View', keywords: 'cron', run: () => selectGlobal('scheduler') },
      { id: 'view-usage', label: 'Usage', hint: 'View', keywords: 'tokens', run: () => selectGlobal('usage') },
    ];
    // Project-scoped sub-views target the active project (or the first project).
    ([['kanban', 'Kanban'], ['memory', 'Memory'], ['chat', 'Chat']] as const).forEach(([sub, label]) => {
      const pid = activeProjectId ?? projects[0]?.id;
      if (pid) cmds.push({ id: `view-${sub}`, label, hint: 'View', keywords: 'open project', run: () => selectSubView(pid, sub) });
    });
    projects.forEach(p => cmds.push({ id: `proj-${p.id}`, label: p.name, hint: 'Project', keywords: p.repo_path, run: () => focusProject(p.id) }));
    cmds.push({ id: 'act-new-project', label: 'New project…', hint: 'Action', run: () => setShowProjectModal(true) });
    if (activeProjectId) cmds.push({ id: 'act-new-task', label: 'New task (Triage)…', hint: 'Action', keywords: 'kanban', run: () => setTaskModalColumn('triage') });
    cmds.push({ id: 'act-personas', label: 'Agents', hint: 'Action', keywords: 'personas agents', run: () => selectGlobal('personas') });
    cmds.push({ id: 'act-settings', label: 'Settings', hint: 'Action', run: () => selectGlobal('settings') });
    cmds.push({ id: 'act-opencode-models', label: 'Models', hint: 'Action', keywords: 'opencode openrouter models', run: () => selectGlobal('opencode-models') });
    cmds.push({ id: 'act-refresh', label: 'Refresh status', hint: 'Action', run: () => loadStatus() });
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId]);

  // --- main content ---------------------------------------------------------
  const renderMain = () => {
    if (globalView === 'personas') return <PersonasPage />;
    if (globalView === 'settings') return <SettingsPage />;
    if (globalView === 'opencode-models') return <OpenCodeModelsView />;
    if (globalView === 'dashboard')
      return <MissionControl status={status} loading={statusLoading} onRefresh={loadStatus} onSelectAgent={() => {}} />;
    if (globalView === 'tickets')
      return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;
    if (globalView === 'scheduler') return <SchedulerPage projectId={activeProjectId ?? undefined} />;
    if (globalView === 'usage') return <UsagePage projectId={activeProjectId ?? undefined} />;

    // Everything below is project-scoped.
    if (!activeProject) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-zinc-400 mb-2">No project selected</h2>
            <p className="text-zinc-500 text-sm mb-4">
              {projects.length === 0 ? 'Create your first project to get started' : 'Pick a project from the tree'}
            </p>
            {projects.length === 0 && (
              <button
                onClick={() => setShowProjectModal(true)}
                className="px-6 py-2 bg-indigo-500 text-ink rounded-lg hover:bg-indigo-600 transition-colors"
              >
                New Project
              </button>
            )}
          </div>
        </div>
      );
    }

    const viewLabel = subView.charAt(0).toUpperCase() + subView.slice(1);

    return (
      <>
        <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900 shrink-0">
          <div>
            <h1 className="text-lg font-semibold">{activeProject.name}</h1>
            <p className="text-xs text-zinc-500">{activeProject.repo_path}</p>
          </div>
          <span className="text-xs text-zinc-500 uppercase tracking-wider">{viewLabel}</span>
        </header>

        <div className="flex-1 overflow-hidden">
          {subView === 'kanban' ? (
            <KanbanBoard
              tasks={tasks}
              columns={KANBAN_COLUMNS}
              columnLabels={KANBAN_COLUMN_LABELS}
              onMoveTask={handleMoveTask}
              onAddTask={status => setTaskModalColumn(status)}
              onEditTask={() => {}}
              onDeleteTask={handleDeleteTask}
            />
          ) : subView === 'chat' ? (
            <ChatPanel
              key={activeProject.id}
              projectId={activeProject.id}
              threadId={activeThreadId}
              agents={status?.agents}
              agentSlug={activeThreadAgentSlug}
              onThreadsChanged={() => loadThreads(activeProject.id)}
            />
          ) : subView === 'memory' ? (
            <MemoryView projectId={activeProject.id} />
          ) : null}
        </div>

        {subView === 'kanban' && (
          <div className="border-t border-zinc-800 bg-zinc-900 px-6 py-3 shrink-0">
            <details className="group">
              <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-200 transition-colors select-none">
                Column-Agent Mapping — click to configure default agents per Kanban column
              </summary>
              <div className="mt-3 max-w-md">
                <ColumnAgentMapping project={activeProject} onUpdate={handleProjectUpdate} />
              </div>
            </details>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <TopBar
        view={globalView ?? ''}
        onSelectGlobal={selectGlobal}
        onSelectManage={selectGlobal}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          subView={subView}
          activeThreadId={activeThreadId}
          threads={activeProjectId ? threadMetas : []}
          onSelectProject={focusProject}
          onSelectSubView={selectSubView}
          onSelectThread={selectThread}
          onNewChat={(projectId) => setNewChat({ projectId })}
          onNewProject={() => setShowProjectModal(true)}
        />

        <main className="flex-1 flex flex-col min-w-0">{renderMain()}</main>
      </div>

      {newChat && (
        <div className="fixed inset-0 z-40" onClick={() => setNewChat(null)}>
          <div className="absolute left-60 top-24" onClick={e => e.stopPropagation()}>
            <NewChatPicker
              personas={(status?.agents ?? []).map(a => ({ slug: a.slug, name: a.name, icon: a.icon, color: a.color }))}
              onStart={startNewChat}
              onClose={() => setNewChat(null)}
            />
          </div>
        </div>
      )}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      <DaemonToasts status={status} />
      <NotificationToasts />

      {showProjectModal && (
        <ProjectModal onClose={() => setShowProjectModal(false)} onSubmit={handleCreateProject} />
      )}

      {taskModalColumn && (
        <TaskModal
          columnLabel={KANBAN_COLUMN_LABELS[taskModalColumn]}
          onClose={() => setTaskModalColumn(null)}
          onSubmit={handleCreateTask}
        />
      )}
    </div>
  );
}
