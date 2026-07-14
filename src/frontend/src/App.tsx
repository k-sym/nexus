import { useState, useEffect, useCallback, useMemo } from 'react';
import { X } from '@phosphor-icons/react';
import { Project, Task, Ticket, ChatThread, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, TaskStatus } from '@nexus/shared';
import { api, MissionStatus } from './api';
import TopBar from './components/TopBar';
import CommandPalette, { Command } from './components/CommandPalette';
import Sidebar, { SubView, ThreadMeta, type ActiveSessionRun } from './components/Sidebar';
import MissionControl from './components/MissionControl';
import TicketsView from './components/TicketsView';
import BraindumpView from './components/BraindumpView';
import DaemonToasts from './components/DaemonToasts';
import NotificationToasts from './components/NotificationToasts';
import ConfirmHost from './components/ConfirmHost';
import KanbanBoard from './components/KanbanBoard';
import ChatPanel from './components/ChatPanel';
import AssistantView from './components/AssistantView';
import MissionsView from './components/MissionsView';
import MemoryView from './components/MemoryView';
import SettingsPage from './components/SettingsPage';
import ProjectModal from './components/ProjectModal';
import TaskModal from './components/TaskModal';
import { TaskModelPicker } from './components/TaskModelPicker';
import MemoryRail from './components/MemoryRail';
import ActivityConsole from './components/ActivityConsole';
import DiffReviewPanel from './components/DiffReviewPanel';
import type { ActivityResponse, OperationKind, OperationStatus, ReviewActionResult } from './api';
import { loadViewState, saveViewState } from './viewState';

type GlobalView = 'dashboard' | 'activity' | 'missions' | 'tickets' | 'braindump' | 'assistant' | 'settings';

/** A task-seeded first turn handed to ChatPanel once the run-task chat opens. */
interface TaskSeed {
  threadId: string;
  prompt: string;
  modelKey: string;
}

/** Build the seeded first chat message from a task — the visible equivalent of
 *  the old headless `buildTaskPrompt`. */
function buildTaskSeedPrompt(task: Task, project: Project): string {
  const parts: string[] = [];
  parts.push(`You are working on a task in the **${project.name}** project.`);
  if (project.repo_path) parts.push(`Working directory: ${project.repo_path}`);
  parts.push(`Priority: ${task.priority}`);
  parts.push('');
  parts.push(`## Task: ${task.title}`);
  if (task.description) parts.push(task.description);
  parts.push('');
  parts.push('Work through this task here. I can steer you as you go.');
  return parts.join('\n');
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [taskModalColumn, setTaskModalColumn] = useState<TaskStatus | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [diffReviewTask, setDiffReviewTask] = useState<Task | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<MissionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityFilters, setActivityFilters] = useState<{ kind: OperationKind | ''; status: OperationStatus | '' }>({
    kind: '',
    status: '',
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [taskPicker, setTaskPicker] = useState<{ taskId: string; title: string } | null>(null);
  const [taskSeed, setTaskSeed] = useState<TaskSeed | null>(null);

  // --- navigation state -----------------------------------------------------
  const [globalView, setGlobalView] = useState<GlobalView | null>('dashboard');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => loadViewState().activeProjectId ?? null);
  const [subView, setSubView] = useState<SubView>(() => loadViewState().subView ?? 'kanban');
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => loadViewState().activeThreadId ?? null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeSessionIds, setActiveSessionIds] = useState<Set<string>>(() => new Set());
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(() => new Set());
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(() => new Set());
  const [waitingProjectIds, setWaitingProjectIds] = useState<Set<string>>(() => new Set());
  const [activeRuns, setActiveRuns] = useState<ActiveSessionRun[]>([]);
  const [archivingThreadIds, setArchivingThreadIds] = useState<Set<string>>(() => new Set());
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [assistantActive, setAssistantActive] = useState(false);

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

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      setActivity(
        await api.activity.list({
          ...(activityFilters.kind ? { kind: activityFilters.kind } : {}),
          ...(activityFilters.status ? { status: activityFilters.status } : {}),
        }),
      );
    } catch (err) {
      console.error('Failed to load activity:', err);
    } finally {
      setActivityLoading(false);
    }
  }, [activityFilters]);

  useEffect(() => {
    loadActivity();
    const interval = setInterval(loadActivity, 15000);
    return () => clearInterval(interval);
  }, [loadActivity]);

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

  // Remember the last-open project / view / thread so a relaunch reopens where
  // you left off (the fix for "renamed session shows New Session on restart" —
  // the rename persists server-side; this restores the client's selection).
  useEffect(() => {
    saveViewState({ activeProjectId, subView, activeThreadId });
  }, [activeProjectId, subView, activeThreadId]);

  // Drop a restored selection whose project/thread no longer exists (e.g. deleted
  // on another device) once the real lists load, so we don't wedge on a ghost id.
  useEffect(() => {
    if (projects.length && activeProjectId && !projects.some((p) => p.id === activeProjectId)) {
      setActiveProjectId(null);
      setActiveThreadId(null);
    }
  }, [projects, activeProjectId]);

  useEffect(() => {
    if (activeThreadId && threads.length && !threads.some((t) => t.id === activeThreadId)) {
      setActiveThreadId(null);
    }
  }, [threads, activeThreadId]);

  useEffect(() => {
    if (activeProjectId) {
      const proj = projects.find((p) => p.id === activeProjectId);
      setActiveProject(proj || null);
      setTasks([]);
      loadTasks(activeProjectId);
    } else {
      setActiveProject(null);
      setTasks([]);
    }
  }, [activeProjectId, projects, loadTasks]);

  useEffect(() => {
    if (!activeProjectId || subView !== 'kanban') return;
    let cancelled = false;
    (async () => {
      try {
        const { created } = await api.projects.githubSync(activeProjectId);
        if (!cancelled && created > 0) await loadTasks(activeProjectId);
      } catch (err) {
        console.error('GitHub sync failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [activeProjectId, subView, loadTasks]);

  useEffect(() => {
    setThreads([]);
    if (activeProjectId) loadThreads(activeProjectId);
  }, [activeProjectId, loadThreads]);

  const refreshActiveChatRuns = useCallback(async () => {
    try {
      const data = await api.chat.activeRuns();
      setActiveRuns(data.runs.map((run) => ({
        threadId: run.threadId,
        title: run.title,
        projectId: run.projectId,
        waitingForResponse: run.waitingForResponse,
      })));
      setActiveSessionIds(new Set(data.activeThreadIds));
      setWaitingSessionIds(new Set(data.runs.filter((run) => run.waitingForResponse).map((run) => run.threadId)));
      setActiveProjectIds(new Set(data.runs.filter((run) => run.projectId).map((run) => run.projectId!)));
      setWaitingProjectIds(new Set(data.runs.filter((run) => run.projectId && run.waitingForResponse).map((run) => run.projectId!)));
    } catch (err) {
      console.error('Failed to load active chat runs:', err);
    }
  }, []);

  useEffect(() => {
    refreshActiveChatRuns();
    const interval = setInterval(refreshActiveChatRuns, 2000);
    return () => clearInterval(interval);
  }, [refreshActiveChatRuns]);

  const refreshAssistantActive = useCallback(async () => {
    try {
      const { sessions } = await api.assistant.sessions();
      const active = sessions.some(
        (s) => s.status === 'running' || s.status === 'cancelling'
          || s.latestRun?.status === 'running' || s.latestRun?.status === 'cancelling',
      );
      setAssistantActive(active);
    } catch (err) {
      console.error('Failed to load assistant active state:', err);
    }
  }, []);

  useEffect(() => {
    refreshAssistantActive();
    const interval = setInterval(refreshAssistantActive, 5000);
    return () => clearInterval(interval);
  }, [refreshAssistantActive]);

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

  const sidebarProjectCounts = useMemo(() => {
    const counts = Object.fromEntries(
      projects.map((project) => [
        project.id,
        {
          tasks: project.task_count ?? 0,
          sessions: project.chat_session_count ?? 0,
        },
      ]),
    );

    if (activeProjectId) {
      counts[activeProjectId] = { tasks: tasks.length, sessions: threads.length };
    }

    return counts;
  }, [projects, activeProjectId, tasks.length, threads.length]);

  const handleCreateProject = async (data: { name: string; description: string; repo_path: string }) => {
    const created = await api.projects.create(data);
    setShowProjectModal(false);
    await refreshProjects();
    selectSubView(created.id, 'kanban');
  };

  const openNewProjectModal = () => {
    setEditingProject(null);
    setShowProjectModal(true);
  };

  const openEditProjectModal = (project: Project) => {
    setEditingProject(project);
    setShowProjectModal(true);
  };

  const handleSaveProject = async (data: { name: string; description: string; repo_path: string }) => {
    if (!editingProject) {
      await handleCreateProject(data);
      return;
    }

    await api.projects.update(editingProject.id, data);
    setShowProjectModal(false);
    setEditingProject(null);
    await refreshProjects();
  };

  const handleDeleteProject = async (projectId: string) => {
    await api.projects.delete(projectId);
    if (projectId === activeProjectId) {
      setActiveProjectId(null);
      setActiveProject(null);
      setActiveThreadId(null);
      setTasks([]);
      setThreads([]);
      setGlobalView('dashboard');
    }
    await refreshProjects();
  };

  const handleReorderProjects = async (projectIds: string[]) => {
    setProjects((current) => {
      const byId = new Map(current.map((project) => [project.id, project]));
      const ordered = projectIds.map((id) => byId.get(id)).filter((project): project is Project => Boolean(project));
      const remaining = current.filter((project) => !projectIds.includes(project.id));
      return [...ordered, ...remaining];
    });

    try {
      await api.projects.reorder(projectIds);
      await refreshProjects();
    } catch (err) {
      console.error('Failed to reorder projects:', err);
      await refreshProjects();
    }
  };

  const handleCreateTask = async (data: { title: string; description: string; priority: string }) => {
    if (!activeProjectId || !taskModalColumn) return;
    await api.projects.createTask(activeProjectId, { ...data, status: taskModalColumn });
    setTaskModalColumn(null);
    await loadTasks(activeProjectId);
  };

  const handleEditTask = async (data: { title: string; description: string; priority: string }) => {
    if (!editingTask) return;
    await api.tasks.update(editingTask.id, { ...data, priority: data.priority as Task['priority'] });
    setEditingTask(null);
    if (activeProjectId) await loadTasks(activeProjectId);
  };

  /**
   * Moving a task to "in_progress" opens an interactive chat. A task already
   * linked to a thread reopens that chat directly; an unlinked task shows the
   * model picker first (which then creates the thread). Other moves are a
   * plain status update.
   */
  const handleMoveTask = async (taskId: string, newStatus: TaskStatus) => {
    if (newStatus === 'in_progress') {
      const task = tasks.find((t) => t.id === taskId);
      if (task?.thread_id && activeProjectId) {
        selectThread(activeProjectId, task.thread_id);
        return;
      }
      if (task) {
        setTaskPicker({ taskId, title: task.title });
        return;
      }
    }
    await api.tasks.update(taskId, { status: newStatus });
    if (activeProjectId) await loadTasks(activeProjectId);
  };

  /** Click a card: linked → reopen its chat; unlinked → edit. */
  const handleOpenTask = (task: Task) => {
    if (task.thread_id && activeProjectId) {
      selectThread(activeProjectId, task.thread_id);
    } else {
      setEditingTask(task);
    }
  };

  const handleOpenDiffReview = (task: Task) => {
    setDiffReviewTask(task);
  };

  const handleDiffTaskCreated = async (created: ReviewActionResult['task']) => {
    if (created && activeProjectId) await loadTasks(activeProjectId);
  };

  const handleDiffTaskAssigned = async (updated: ReviewActionResult['task']) => {
    if (!updated || !activeProjectId) return;
    setTasks((current) => current.map((task) => (task.id === updated.id ? { ...task, assigned_agent: updated.assigned_agent } : task)));
  };

  const handleDiffChatSeed = (seed: NonNullable<ReviewActionResult['seed']>) => {
    if (!activeProjectId || !seed.threadId) return;
    setTaskSeed({ threadId: seed.threadId, prompt: seed.prompt, modelKey: seed.modelKey ?? '' });
    selectThread(activeProjectId, seed.threadId);
  };

  /**
   * "Run task" from the picker: create a chat thread titled after the task,
   * link it (thread_id + model_key) and flip the card to in_progress, then
   * navigate to the chat and seed its first turn so the agent starts working.
   */
  const handleRunTask = async (modelKey: string) => {
    if (!taskPicker || !activeProjectId) return;
    const { taskId } = taskPicker;
    setTaskPicker(null);
    const task = tasks.find((t) => t.id === taskId);
    const project = projects.find((p) => p.id === activeProjectId);
    if (!task || !project) return;

    // Reopen if it somehow already has a thread (avoid duplicates).
    if (task.thread_id) {
      selectThread(activeProjectId, task.thread_id);
      return;
    }

    try {
      const thread = await api.chat.createThread(activeProjectId, task.title);
      await api.tasks.update(taskId, { status: 'in_progress', thread_id: thread.id, model_key: modelKey });
      await loadThreads(activeProjectId);
      await loadTasks(activeProjectId);
      setTaskSeed({ threadId: thread.id, prompt: buildTaskSeedPrompt(task, project), modelKey });
      selectThread(activeProjectId, thread.id);
    } catch (err) {
      console.error('Failed to start task chat', err);
    }
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

  const handleTriageIdea = async (projectId: string, idea: { title: string; body: string }): Promise<string> => {
    const task = await api.projects.createTask(projectId, {
      title: idea.title,
      description: idea.body || '',
      status: 'triage',
      priority: 'medium',
    });
    if (projectId === activeProjectId) await loadTasks(projectId);
    return task.id;
  };

  // --- navigation helpers ---------------------------------------------------
  const selectGlobal = (v: GlobalView) => {
    setGlobalView(v);
    setActiveThreadId(null);
  };
  const focusProject = (id: string) => {
    setGlobalView(null);
    if (id !== activeProjectId) setActiveThreadId(null);
    setActiveProjectId(id);
  };
  const selectSubView = (projectId: string, sub: SubView) => {
    setGlobalView(null);
    if (projectId !== activeProjectId || sub !== 'chat') setActiveThreadId(null);
    setActiveProjectId(projectId);
    setSubView(sub);
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

  const handleArchiveThread = async (threadId: string) => {
    if (archivingThreadIds.has(threadId)) return;
    setArchiveError(null);
    setArchivingThreadIds((current) => new Set(current).add(threadId));
    try {
      await api.chat.archiveThread(threadId);
      if (threadId === activeThreadId) setActiveThreadId(null);
      if (activeProjectId) await loadThreads(activeProjectId);
      await loadActivity();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to archive session.';
      setArchiveError(message);
      console.error('Failed to archive session:', err);
      await loadActivity();
    } finally {
      setArchivingThreadIds((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    }
  };

  const handleDeleteThread = async (threadId: string) => {
    await api.chat.deleteThread(threadId);
    if (threadId === activeThreadId) setActiveThreadId(null);
    if (activeProjectId) await loadThreads(activeProjectId);
  };

  const startNewSession = async (projectId: string) => {
    const thread = await api.chat.createThread(projectId);
    await loadThreads(projectId);
    selectThread(projectId, thread.id);
  };

  const handleAbortActivity = useCallback(async (id: string) => {
    try {
      await api.activity.abort(id);
      await loadActivity();
    } catch (err) {
      console.error('Failed to abort operation:', err);
    }
  }, [loadActivity]);

  const handleRetryActivity = useCallback(async (id: string) => {
    try {
      await api.activity.retry(id);
      await loadActivity();
    } catch (err) {
      console.error('Failed to retry operation:', err);
    }
  }, [loadActivity]);

  const handleCopyActivityDiagnostics = useCallback(async (id: string) => {
    try {
      const d = await api.activity.diagnostics(id);
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
    } catch (err) {
      console.error('Failed to copy diagnostics:', err);
    }
  }, []);

  const handleSessionActivityChange = useCallback((threadId: string, active: boolean) => {
    setActiveSessionIds((current) => {
      const next = new Set(current);
      if (active) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }, []);

  // --- command palette entries ---------------------------------------------
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: 'view-dashboard', label: 'Dashboard', hint: 'View', keywords: 'mission control', run: () => selectGlobal('dashboard') },
      { id: 'view-activity', label: 'Activity Console', hint: 'View', keywords: 'operations running recent', run: () => selectGlobal('activity') },
      { id: 'view-tickets', label: 'Tickets', hint: 'View', run: () => selectGlobal('tickets') },
      { id: 'view-braindump', label: 'Braindump', hint: 'View', keywords: 'ideas capture', run: () => selectGlobal('braindump') },
      { id: 'view-assistant', label: 'Assistant', hint: 'View', keywords: 'hermes openclaw remote chat', run: () => selectGlobal('assistant') },
    ];
    (['kanban', 'memory', 'chat'] as const).forEach((sub) => {
      const label = sub === 'chat' ? 'Sessions' : sub.charAt(0).toUpperCase() + sub.slice(1);
      const pid = activeProjectId ?? projects[0]?.id;
      if (pid) cmds.push({ id: `view-${sub}`, label, hint: 'View', keywords: 'open project', run: () => selectSubView(pid, sub) });
    });
    projects.forEach((p) => cmds.push({ id: `proj-${p.id}`, label: p.name, hint: 'Project', keywords: p.repo_path, run: () => focusProject(p.id) }));
    cmds.push({ id: 'act-new-project', label: 'New project…', hint: 'Action', run: openNewProjectModal });
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
    if (globalView === 'activity')
      return (
        <ActivityConsole
          operations={activity}
          loading={activityLoading}
          projects={projects}
          tasks={tasks}
          threads={threadMetas}
          filters={activityFilters}
          onFiltersChange={setActivityFilters}
          onRefresh={loadActivity}
          onSelectProject={focusProject}
          onSelectThread={selectThread}
          onAbort={handleAbortActivity}
          onRetry={handleRetryActivity}
          onCopyDiagnostics={handleCopyActivityDiagnostics}
        />
      );
    if (globalView === 'tickets')
      return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;
    if (globalView === 'braindump')
      return <BraindumpView projects={projects} onTriage={handleTriageIdea} />;
    if (globalView === 'missions')
      return <MissionsView projects={projects} />;
    if (globalView === 'assistant')
      return <AssistantView />;

    if (!activeProject) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-muted mb-2">No project selected</h2>
            <p className="text-faint text-sm mb-4">
              {projects.length === 0 ? 'Create your first project to get started' : 'Pick a project from the tree'}
            </p>
            {projects.length === 0 && (
              <button
                onClick={openNewProjectModal}
                className="px-6 py-2 accent-button rounded-lg transition-colors"
              >
                New Project
              </button>
            )}
          </div>
        </div>
      );
    }

    const viewLabel = subView === 'chat' ? 'Sessions' : subView.charAt(0).toUpperCase() + subView.slice(1);

    return (
      <>
        <header className="surface-glass flex items-center justify-between px-6 py-3 border-b border-subtle shrink-0">
          <div>
            <h1 className="text-lg font-semibold">{activeProject.name}</h1>
            <p className="text-xs text-faint">{activeProject.repo_path}</p>
          </div>
          <span className="text-xs text-faint uppercase tracking-wider">{viewLabel}</span>
        </header>

        <div className="flex-1 overflow-hidden">
          {subView === 'kanban' ? (
            <KanbanBoard
              tasks={tasks}
              columns={KANBAN_COLUMNS}
              columnLabels={KANBAN_COLUMN_LABELS}
              onMoveTask={handleMoveTask}
              onAddTask={(status) => setTaskModalColumn(status)}
              onOpenTask={handleOpenTask}
              onDeleteTask={handleDeleteTask}
              onOpenDiffReview={handleOpenDiffReview}
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
                  onSessionActivityChange={handleSessionActivityChange}
                  backendActiveThreadIds={activeSessionIds}
                  seed={taskSeed}
                  onSeedConsumed={() => setTaskSeed(null)}
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
    <div className="ambient-shell surface-canvas flex flex-col h-screen w-screen overflow-hidden">
      <div className="ambient-particle-layer ambient-particles-far" aria-hidden="true" />
      <div className="ambient-particle-layer ambient-particles-mid" aria-hidden="true" />
      <div className="ambient-particle-layer ambient-particles-near" aria-hidden="true" />

      <TopBar
        view={globalView ?? ''}
        onSelectGlobal={selectGlobal}
        onSelectManage={selectGlobal}
        onOpenPalette={() => setPaletteOpen(true)}
        assistantActive={assistantActive}
      />

      <div className="flex flex-1 min-h-0">
        {globalView !== 'assistant' && (
          <Sidebar
            projects={projects}
            activeProjectId={activeProjectId}
            subView={subView}
            activeThreadId={activeThreadId}
            threads={activeProjectId ? threadMetas : []}
            activeSessionIds={activeSessionIds}
            waitingSessionIds={waitingSessionIds}
            activeProjectIds={activeProjectIds}
            waitingProjectIds={waitingProjectIds}
            activeRuns={activeRuns}
            archivingThreadIds={archivingThreadIds}
            projectCounts={sidebarProjectCounts}
            onSelectProject={focusProject}
            onSelectSubView={selectSubView}
            onSelectThread={selectThread}
            onRenameThread={handleRenameThread}
            onArchiveThread={handleArchiveThread}
            onDeleteThread={handleDeleteThread}
            onNewChat={(projectId) => void startNewSession(projectId)}
            onNewProject={openNewProjectModal}
            onEditProject={openEditProjectModal}
            onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
            onReorderProjects={(projectIds) => void handleReorderProjects(projectIds)}
          />
        )}

        <main className="flex-1 flex flex-col min-w-0">{renderMain()}</main>
      </div>
      {archiveError && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded-md border border-red-400/30 bg-red-950/80 px-4 py-3 text-sm text-red-100 shadow-lg backdrop-blur"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium">Archive failed</div>
            <div className="mt-1 text-red-100/80">{archiveError}</div>
          </div>
          <button
            type="button"
            title="Dismiss archive error"
            aria-label="Dismiss archive error"
            onClick={() => setArchiveError(null)}
            className="shrink-0 rounded p-0.5 text-red-100/60 transition-colors hover:bg-red-100/10 hover:text-red-50"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      <DaemonToasts status={status} />
      <NotificationToasts />
      <ConfirmHost />

      {diffReviewTask && activeProjectId && (
        <DiffReviewPanel
          projectId={activeProjectId}
          task={{ id: diffReviewTask.id, title: diffReviewTask.title }}
          onClose={() => setDiffReviewTask(null)}
          onTaskCreated={(created) => void handleDiffTaskCreated(created)}
          onTaskAssigned={(updated) => void handleDiffTaskAssigned(updated)}
          onChatSeed={handleDiffChatSeed}
        />
      )}

      {showProjectModal && (
        <ProjectModal
          project={editingProject ?? undefined}
          onClose={() => {
            setShowProjectModal(false);
            setEditingProject(null);
          }}
          onSubmit={handleSaveProject}
        />
      )}

      {taskModalColumn && (
        <TaskModal
          columnLabel={KANBAN_COLUMN_LABELS[taskModalColumn]}
          onClose={() => setTaskModalColumn(null)}
          onSubmit={handleCreateTask}
        />
      )}

      {editingTask && (
        <TaskModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSubmit={handleEditTask}
        />
      )}

      {taskPicker && (
        <TaskModelPicker
          open={true}
          onPick={handleRunTask}
          onClose={() => setTaskPicker(null)}
        />
      )}
    </div>
  );
}
