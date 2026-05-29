import { useState, useEffect, useCallback } from 'react';
import { Project, Task, KANBAN_COLUMNS, KANBAN_COLUMN_LABELS, TaskStatus } from '@nexus/shared';
import { api } from './api';
import Sidebar from './components/Sidebar';
import KanbanBoard from './components/KanbanBoard';
import ChatPanel from './components/ChatPanel';
import PersonasPage from './components/PersonasPage';
import SchedulerPage from './components/SchedulerPage';
import SettingsPage from './components/SettingsPage';
import UsagePage from './components/UsagePage';
import ProjectModal from './components/ProjectModal';
import TaskModal from './components/TaskModal';
import ColumnAgentMapping from './components/ColumnAgentMapping';

type ActiveView = 'kanban' | 'chat' | 'scheduler' | 'usage' | 'personas' | 'settings';

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<ActiveView>('kanban');
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [taskModalColumn, setTaskModalColumn] = useState<TaskStatus | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);

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
    await api.projects.create(data);
    setShowProjectModal(false);
    await refreshProjects();
  };

  const handleCreateTask = async (data: { title: string; description: string; priority: string }) => {
    if (!activeProjectId || !taskModalColumn) return;
    await api.projects.createTask(activeProjectId, {
      ...data,
      status: taskModalColumn,
    });
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

  const handleProjectUpdate = (updated: Project) => {
    setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    if (updated.id === activeProjectId) setActiveProject(updated);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        projects={projects}
        activeProjectId={(view === 'personas' || view === 'settings') ? null : activeProjectId}
        activeGlobalView={view === 'personas' ? 'personas' : view === 'settings' ? 'settings' : null}
        onSelectProject={id => { setActiveProjectId(id); setView('kanban'); }}
        onNewProject={() => setShowProjectModal(true)}
        onSelectPersonas={() => setView('personas')}
        onSelectSettings={() => setView('settings')}
      />

      <main className="flex-1 flex flex-col min-w-0">
        {view === 'personas' ? (
          <PersonasPage />
        ) : view === 'settings' ? (
          <SettingsPage />
        ) : activeProject ? (
          <>
            <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900">
              <div>
                <h1 className="text-lg font-semibold">{activeProject.name}</h1>
                <p className="text-xs text-zinc-500">{activeProject.repo_path}</p>
              </div>
              <div className="flex gap-1 bg-zinc-950 rounded-lg p-1">
                <button
                  onClick={() => setView('kanban')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${view === 'kanban' ? 'bg-indigo-500 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
                >
                  Kanban
                </button>
                <button
                  onClick={() => setView('chat')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${view === 'chat' ? 'bg-indigo-500 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
                >
                  Chat
                </button>
                <button
                  onClick={() => setView('scheduler')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${view === 'scheduler' ? 'bg-indigo-500 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
                >
                  Scheduler
                </button>
                <button
                  onClick={() => setView('usage')}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${view === 'usage' ? 'bg-indigo-500 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
                >
                  Usage
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-hidden">
              {view === 'kanban' ? (
                <KanbanBoard
                  tasks={tasks}
                  columns={KANBAN_COLUMNS}
                  columnLabels={KANBAN_COLUMN_LABELS}
                  onMoveTask={handleMoveTask}
                  onAddTask={(status) => setTaskModalColumn(status)}
                  onEditTask={() => {}}
                  onDeleteTask={handleDeleteTask}
                />
              ) : view === 'chat' ? (
                <ChatPanel projectId={activeProject.id} />
              ) : view === 'usage' ? (
                <UsagePage projectId={activeProject.id} />
              ) : (
                <SchedulerPage projectId={activeProject.id} />
              )}
            </div>

            {view === 'kanban' && (
              <div className="border-t border-zinc-800 bg-zinc-900 px-6 py-3">
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
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-zinc-500 mb-2">Welcome to NEXUS</h2>
              <p className="text-zinc-500 text-sm mb-4">Create your first project to get started</p>
              <button
                onClick={() => setShowProjectModal(true)}
                className="px-6 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-500 transition-colors"
              >
                New Project
              </button>
            </div>
          </div>
        )}
      </main>

      {showProjectModal && (
        <ProjectModal
          onClose={() => setShowProjectModal(false)}
          onSubmit={handleCreateProject}
        />
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
