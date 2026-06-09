import { useState, useEffect, useCallback, useMemo } from 'react';
import { Project, Task, Ticket, ChatThread, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, TaskStatus } from '@nexus/shared';
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
import SchedulerPage from './components/SchedulerPage';
import SettingsPage from './components/SettingsPage';
import UsagePage from './components/UsagePage';
import ProjectModal from './components/ProjectModal';
import TaskModal from './components/TaskModal';
import { OrchestratorModelPicker } from './components/OrchestratorModelPicker';
import MemoryRail from './components/MemoryRail';

type GlobalView = 'dashboard' | 'tickets' | 'scheduler' | 'usage' | 'settings';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [taskModalColumn, setTaskModalColumn] = useState<TaskStatus | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<MissionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [orchestratorPicker, setOrchestratorPicker] = useState<{ taskId: string; title: string } | null>(null);

  // --- navigation state -----------------------------------------------------
  const [globalView, setGlobalView] = useState<GlobalView | null>('dashboard');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [subView, setSubView] = useState<SubView>('kanban');
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);

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
        setPaletteOpen((o) => !o);
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
    try {
      const data = await api.chat.threads(projectId);
      setThreads(data);
    } catch (err) {
      console.error('Failed to load threads:', err);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (activeProjectId) {
      const proj = projects.find((p) => p.id === activeProjectId);
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

  // The sidebar consumes a flat ThreadMeta list; the new chat model has
  // no persona icon/color to surface.
  const threadMetas: ThreadMeta[] = useMemo(
    () => threads.map((t) => ({ thread: t })),
    [threads],
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

  /**
   * Moving a task to "in_progress" opens the model picker. The picker
   * POSTs to /api/orchestrator/tasks/:id/start which sets model_key
   * and flips status to in_progress; the orchestrator's next poll tick
   * dispatches headlessly.
   */
  const handleMoveTask = async (taskId: string, newStatus: TaskStatus) => {
    if (newStatus === 'in_progress') {
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        setOrchestratorPicker({ taskId, title: task.title });
        return;
      }
    }
    await api.tasks.update(taskId, { status: newStatus });
    if (activeProjectId) await loadTasks(activeProjectId);
  };

  const handleOrchestratorPick = async (modelKey: string) => {
    if (!orchestratorPicker) return;
    const { taskId } = orchestratorPicker;
    setOrchestratorPicker(null);
    try {
      await api.agents.startTask(taskId, modelKey);
    } catch (err) {
      console.error('Failed to start task', err);
    }
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

  // --- navigation helpers ---------------------------------------------------
  const selectGlobal = (v: GlobalView) => {
    setGlobalView(v);
    setActiveThreadId(null);
  };
  const focusProject = (id: string) => {
    setGlobalView(null);
    setActiveProjectId(id);
  };
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

  const handleRenameThread = async (threadId: string, title: string) => {
    await api.chat.renameThread(threadId, title);
    if (activeProjectId) await loadThreads(activeProjectId);
  };

  const handleDeleteThread = async (threadId: string) => {
    await api.chat.deleteThread(threadId);
    if (threadId === activeThreadId) setActiveThreadId(null);
    if (activeProjectId) await loadThreads(activeProjectId);
  };

  const startNewChat = async (projectId: string) => {
    const thread = await api.chat.createThread(projectId, 'zosma');
    await loadThreads(projectId);
    selectThread(projectId, thread.id);
  };

  // --- command palette entries ---------------------------------------------
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: 'view-dashboard', label: 'Dashboard', hint: 'View', keywords: 'mission control', run: () => selectGlobal('dashboard') },
      { id: 'view-tickets', label: 'Tickets', hint: 'View', run: () => selectGlobal('tickets') },
      { id: 'view-scheduler', label: 'Scheduler', hint: 'View', keywords: 'cron', run: () => selectGlobal('scheduler') },
      { id: 'view-usage', label: 'Usage', hint: 'View', keywords: 'tokens', run: () => selectGlobal('usage') },
    ];
    (['kanban', 'memory', 'chat'] as const).forEach((sub) => {
      const label = sub.charAt(0).toUpperCase() + sub.slice(1);
      const pid = activeProjectId ?? projects[0]?.id;
      if (pid) cmds.push({ id: `view-${sub}`, label, hint: 'View', keywords: 'open project', run: () => selectSubView(pid, sub) });
    });
    projects.forEach((p) => cmds.push({ id: `proj-${p.id}`, label: p.name, hint: 'Project', keywords: p.repo_path, run: () => focusProject(p.id) }));
    cmds.push({ id: 'act-new-project', label: 'New project…', hint: 'Action', run: () => setShowProjectModal(true) });
    if (activeProjectId) cmds.push({ id: 'act-new-task', label: 'New task (Triage)…', hint: 'Action', keywords: 'kanban', run: () => setTaskModalColumn('triage') });
    cmds.push({ id: 'act-settings', label: 'Settings', hint: 'Action', run: () => selectGlobal('settings') });
    cmds.push({ id: 'act-refresh', label: 'Refresh status', hint: 'Action', run: () => loadStatus() });
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, activeProjectId]);

  // --- main content ---------------------------------------------------------
  const renderMain = () => {
    if (globalView === 'settings') return <SettingsPage />;
    if (globalView === 'dashboard')
      return <MissionControl status={status} loading={statusLoading} onRefresh={loadStatus} onSelectAgent={() => {}} />;
    if (globalView === 'tickets')
      return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;
    if (globalView === 'scheduler') return <SchedulerPage projectId={activeProjectId ?? undefined} />;
    if (globalView === 'usage') return <UsagePage projectId={activeProjectId ?? undefined} />;

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
              onAddTask={(status) => setTaskModalColumn(status)}
              onEditTask={() => {}}
              onDeleteTask={handleDeleteTask}
            />
          ) : subView === 'chat' ? (
            <div className="flex h-full min-h-0">
              <div className="flex-1 min-w-0">
                <ChatPanel
                  key={activeProject.id}
                  projectId={activeProject.id}
                  threadId={activeThreadId}
                  onBusyConflict={() => {}}
                  onThreadsChanged={() => loadThreads(activeProject.id)}
                />
              </div>
              <MemoryRail
                projectId={activeProject.id}
                onOpenFull={() => selectSubView(activeProject.id, 'memory')}
              />
            </div>
          ) : subView === 'memory' ? (
            <MemoryView projectId={activeProject.id} />
          ) : null}
        </div>
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
          onRenameThread={handleRenameThread}
          onDeleteThread={handleDeleteThread}
          onNewChat={(projectId) => void startNewChat(projectId)}
          onNewProject={() => setShowProjectModal(true)}
        />

        <main className="flex-1 flex flex-col min-w-0">{renderMain()}</main>
      </div>

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

      {orchestratorPicker && (
        <OrchestratorModelPicker
          open={true}
          onPick={handleOrchestratorPick}
          onClose={() => setOrchestratorPicker(null)}
        />
      )}
    </div>
  );
}
