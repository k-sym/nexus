import { useState, useEffect, useCallback, useMemo } from 'react';
import { Project, Task, Persona, Ticket, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, TaskStatus } from '@nexus/shared';
import { api, MissionStatus, AgentHealth } from './api';
import TopBar from './components/TopBar';
import CommandPalette, { Command } from './components/CommandPalette';
import Sidebar from './components/Sidebar';
import MissionControl from './components/MissionControl';
import TicketsView from './components/TicketsView';
import DaemonToasts from './components/DaemonToasts';
import KanbanBoard from './components/KanbanBoard';
import ChatPanel from './components/ChatPanel';
import AgentRoom from './components/AgentRoom';
import MemoryView from './components/MemoryView';
import PersonasPage from './components/PersonasPage';
import SchedulerPage from './components/SchedulerPage';
import SettingsPage from './components/SettingsPage';
import UsagePage from './components/UsagePage';
import ProjectModal from './components/ProjectModal';
import TaskModal from './components/TaskModal';
import ColumnAgentMapping from './components/ColumnAgentMapping';

// Global (project-less) views vs project-scoped views vs per-agent rooms (`agent:<slug>`).
type View =
  | 'mission-control'
  | 'tickets'
  | 'personas'
  | 'settings'
  | 'kanban'
  | 'chat'
  | 'memory'
  | 'scheduler'
  | 'usage'
  | `agent:${string}`;

const GLOBAL_VIEWS = ['mission-control', 'tickets', 'personas', 'settings'];
const isGlobalView = (v: View) => GLOBAL_VIEWS.includes(v);
const isAgentView = (v: View) => v.startsWith('agent:');

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>('mission-control');
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [taskModalColumn, setTaskModalColumn] = useState<TaskStatus | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<MissionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
    if (!activeProjectId) return;
    const interval = setInterval(() => {
      if (activeProjectId) loadTasks(activeProjectId);
    }, 5000);
    return () => clearInterval(interval);
  }, [activeProjectId, loadTasks]);

  const handleCreateProject = async (data: { name: string; description: string; repo_path: string }) => {
    const created = await api.projects.create(data);
    setShowProjectModal(false);
    await refreshProjects();
    setActiveProjectId(created.id);
    setView('kanban');
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
  const goToView = (v: View) => {
    // project-scoped views need an active project — auto-pick the first if none.
    if (!isGlobalView(v) && !activeProjectId && projects.length > 0) {
      setActiveProjectId(projects[0].id);
    }
    setView(v);
  };

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    if (isGlobalView(view)) setView('kanban');
  };

  const agentName = (slug: string) => personas.find(p => p.slug === slug)?.name ?? slug;

  // --- command palette entries ---------------------------------------------
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: 'view-mission-control', label: '◆ Mission Control', hint: 'View', run: () => setView('mission-control') },
      { id: 'view-tickets', label: '🎫 Tickets', hint: 'View', run: () => setView('tickets') },
    ];
    ([['kanban', 'Kanban'], ['chat', 'Chat'], ['memory', 'Memory'], ['scheduler', 'Scheduler'], ['usage', 'Usage']] as const)
      .forEach(([id, label]) => cmds.push({ id: `view-${id}`, label, hint: 'View', keywords: 'open', run: () => goToView(id as View) }));
    projects.forEach(p => cmds.push({ id: `proj-${p.id}`, label: p.name, hint: 'Project', keywords: p.repo_path, run: () => selectProject(p.id) }));
    personas.forEach(p => cmds.push({ id: `agent-${p.slug}`, label: p.name, hint: 'Agent', keywords: `chat ${p.slug}`, run: () => goToView(`agent:${p.slug}`) }));
    cmds.push({ id: 'act-new-project', label: 'New project…', hint: 'Action', run: () => setShowProjectModal(true) });
    if (activeProjectId) cmds.push({ id: 'act-new-task', label: 'New task (Triage)…', hint: 'Action', keywords: 'kanban', run: () => setTaskModalColumn('triage') });
    cmds.push({ id: 'act-personas', label: 'Personas', hint: 'Action', keywords: 'agents', run: () => setView('personas') });
    cmds.push({ id: 'act-settings', label: 'Settings', hint: 'Action', run: () => setView('settings') });
    cmds.push({ id: 'act-refresh', label: 'Refresh status', hint: 'Action', run: () => loadStatus() });
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, personas, activeProjectId, view]);

  // --- main content ---------------------------------------------------------
  const renderMain = () => {
    if (view === 'personas') return <PersonasPage />;
    if (view === 'settings') return <SettingsPage />;
    if (view === 'mission-control')
      return (
        <MissionControl
          status={status}
          loading={statusLoading}
          onRefresh={loadStatus}
          onSelectAgent={slug => goToView(`agent:${slug}`)}
        />
      );
    if (view === 'tickets')
      return <TicketsView projects={projects} onCreateTask={handleCreateTaskFromTicket} />;

    // Everything below is project-scoped.
    if (!activeProject) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-zinc-400 mb-2">No project selected</h2>
            <p className="text-zinc-500 text-sm mb-4">
              {projects.length === 0 ? 'Create your first project to get started' : 'Pick a project from the top bar'}
            </p>
            {projects.length === 0 && (
              <button
                onClick={() => setShowProjectModal(true)}
                className="px-6 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors"
              >
                New Project
              </button>
            )}
          </div>
        </div>
      );
    }

    const viewLabel = isAgentView(view)
      ? agentName(view.slice('agent:'.length))
      : view.charAt(0).toUpperCase() + view.slice(1);

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
          {view === 'kanban' ? (
            <KanbanBoard
              tasks={tasks}
              columns={KANBAN_COLUMNS}
              columnLabels={KANBAN_COLUMN_LABELS}
              onMoveTask={handleMoveTask}
              onAddTask={status => setTaskModalColumn(status)}
              onEditTask={() => {}}
              onDeleteTask={handleDeleteTask}
            />
          ) : view === 'chat' ? (
            <ChatPanel projectId={activeProject.id} />
          ) : view === 'memory' ? (
            <MemoryView projectId={activeProject.id} />
          ) : view === 'usage' ? (
            <UsagePage projectId={activeProject.id} />
          ) : view === 'scheduler' ? (
            <SchedulerPage projectId={activeProject.id} />
          ) : isAgentView(view) ? (
            (() => {
              const slug = view.slice('agent:'.length);
              return (
                <AgentRoom
                  projectId={activeProject.id}
                  slug={slug}
                  name={agentName(slug)}
                  agent={status?.agents.find(a => a.slug === slug)}
                  runningTasks={tasks.filter(t => t.assigned_agent === slug && t.status === 'in_progress')}
                />
              );
            })()
          ) : null}
        </div>

        {view === 'kanban' && (
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
        projects={projects}
        activeProjectId={activeProjectId}
        isGlobal={isGlobalView(view)}
        view={view}
        onSelectGlobal={v => setView(v)}
        onSelectProject={selectProject}
        onNewProject={() => setShowProjectModal(true)}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          personas={personas}
          view={view}
          hasProject={!!activeProjectId}
          agentStatus={Object.fromEntries((status?.agents ?? []).map(a => [a.slug, a.status])) as Record<string, AgentHealth>}
          onSelectView={v => goToView(v as View)}
          onSelectAgent={slug => goToView(`agent:${slug}`)}
        />

        <main className="flex-1 flex flex-col min-w-0">{renderMain()}</main>
      </div>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      <DaemonToasts status={status} />

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
