import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar, { type ThreadMeta } from './Sidebar';
import type { ChatThread, Project } from '@nexus/shared';

const project: Project = {
  id: 'project-1',
  slug: 'nexus',
  name: 'nexus',
  description: '',
  repo_path: '/repo/nexus',
  config_json: '{}',
  git_remote: '',
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
};

const secondProject: Project = {
  ...project,
  id: 'project-2',
  slug: 'mywise',
  name: 'mywise',
  repo_path: '/repo/mywise',
};

const thread: ChatThread = {
  id: 'thread-1',
  project_id: project.id,
  title: 'Inspect progress docs first',
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
  archived_at: null,
};

const noop = vi.fn();

function renderSidebar({
  threads = [{ thread }],
  subView = 'chat',
  activeThreadId = thread.id,
  activeSessionIds = new Set<string>(),
  waitingSessionIds = new Set<string>(),
  activeProjectIds = new Set<string>(),
  waitingProjectIds = new Set<string>(),
  archivingThreadIds = new Set<string>(),
  onEditProject = noop,
  onDeleteProject = noop,
  onReorderProjects = noop,
  onArchiveThread = noop,
  onDeleteThread = noop,
  onNewChat = noop,
}: {
  threads?: ThreadMeta[];
  subView?: 'kanban' | 'memory' | 'chat';
  activeThreadId?: string | null;
  activeSessionIds?: Set<string>;
  waitingSessionIds?: Set<string>;
  activeProjectIds?: Set<string>;
  waitingProjectIds?: Set<string>;
  archivingThreadIds?: Set<string>;
  onEditProject?: (project: Project) => void;
  onDeleteProject?: (projectId: string) => void;
  onReorderProjects?: (projectIds: string[]) => void;
  onArchiveThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onNewChat?: (projectId: string) => void;
} = {}) {
  return render(
    <Sidebar
      projects={[project, secondProject]}
      activeProjectId={project.id}
      subView={subView}
      activeThreadId={activeThreadId}
      threads={threads}
      activeSessionIds={activeSessionIds}
      waitingSessionIds={waitingSessionIds}
      activeProjectIds={activeProjectIds}
      waitingProjectIds={waitingProjectIds}
      archivingThreadIds={archivingThreadIds}
      projectCounts={{
        [project.id]: { tasks: 3, sessions: threads.length },
        [secondProject.id]: { tasks: 10, sessions: 2 },
      }}
      onSelectProject={noop}
      onSelectSubView={noop}
      onSelectThread={noop}
      onRenameThread={noop}
      onArchiveThread={onArchiveThread}
      onDeleteThread={onDeleteThread}
      onNewChat={onNewChat}
      onNewProject={noop}
      onEditProject={onEditProject}
      onDeleteProject={onDeleteProject}
      onReorderProjects={onReorderProjects}
    />,
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('labels chat threads as sessions and shows active session activity', () => {
    renderSidebar({ threads: [{ thread }], activeSessionIds: new Set([thread.id]) });

    expect(screen.getByLabelText('Project sessions')).toHaveTextContent('Inspect progress docs first');
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.getByTitle('Session active')).toBeInTheDocument();
  });

  it('shows a waiting-for-response marker instead of the active spinner', () => {
    renderSidebar({
      threads: [{ thread }],
      activeSessionIds: new Set([thread.id]),
      waitingSessionIds: new Set([thread.id]),
    });

    expect(screen.getByTitle('Waiting for response')).toBeInTheDocument();
    expect(screen.queryByTitle('Session active')).not.toBeInTheDocument();
  });

  it('shows an empty sessions state', () => {
    renderSidebar({ threads: [] });

    expect(screen.getByText('No sessions')).toBeInTheDocument();
    expect(screen.queryByText('No conversations')).not.toBeInTheDocument();
  });

  it('shows active project counts with a new session action in the workspace', () => {
    renderSidebar({ threads: [{ thread }, { thread: { ...thread, id: 'thread-2', title: 'Second session' } }] });

    expect(screen.getByText('3 tasks')).toBeInTheDocument();
    expect(screen.getByText('2 sessions')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Session' })).toBeInTheDocument();
  });

  it('renders a compact project rail beside the project details panel', () => {
    renderSidebar();

    expect(screen.getByLabelText('Project rail')).toBeInTheDocument();
    expect(screen.getByLabelText('Project details')).toBeInTheDocument();
    expect(screen.getByTitle('nexus')).toHaveTextContent('N');
    expect(screen.getByTitle('mywise')).toHaveTextContent('M');
  });

  it('shows the active project as a summary card in the details panel', () => {
    renderSidebar();

    const summary = screen.getByLabelText('Active project: nexus');
    expect(summary).toHaveTextContent('nexus');
    expect(summary).toHaveTextContent('/repo/nexus');
    expect(summary).toHaveTextContent('3 tasks');
    expect(summary).toHaveTextContent('1 session');
  });

  it('promotes running and waiting sessions into an active sessions section', () => {
    const waitingThread: ChatThread = {
      ...thread,
      id: 'thread-2',
      title: 'Waiting on approval',
    };

    renderSidebar({
      threads: [{ thread }, { thread: waitingThread }],
      activeSessionIds: new Set([thread.id, waitingThread.id]),
      waitingSessionIds: new Set([waitingThread.id]),
    });

    const activeSection = screen.getByLabelText('Active sessions');
    expect(activeSection).toHaveTextContent('Inspect progress docs first');
    expect(activeSection).toHaveTextContent('RUN');
    expect(activeSection).toHaveTextContent('Waiting on approval');
    expect(activeSection).toHaveTextContent('WAIT');
  });

  it('uses compact dark rail styling hooks and removes the repeated project list', () => {
    renderSidebar();

    expect(screen.getByLabelText('Project rail')).toHaveClass('compact-project-rail');
    expect(screen.getByLabelText('Project details')).toHaveClass('compact-project-panel');
    expect(screen.getByLabelText('Active project: nexus')).toHaveClass('compact-project-card');
    expect(screen.queryByLabelText('Project group: nexus')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Project group: mywise')).not.toBeInTheDocument();
  });

  it('places active project destinations directly under the active project card', () => {
    renderSidebar();

    const workspace = screen.getByLabelText('Active project workspace');
    expect(workspace.querySelector('.compact-project-workspace')).toBeInTheDocument();
    expect(workspace).toHaveTextContent('Kanban');
    expect(workspace).toHaveTextContent('Memory');
    expect(workspace).toHaveTextContent('New Session');
    expect(workspace).not.toHaveTextContent('Sessions');
    expect(workspace).toHaveTextContent('Project intelligence');
  });

  it('uses the new session action row to start a new session', async () => {
    const user = userEvent.setup();
    const onNewChat = vi.fn();
    renderSidebar({ onNewChat });

    const workspaceCard = screen.getByLabelText('Active project navigation');
    expect(workspaceCard).toHaveTextContent('New Session');
    expect(workspaceCard).not.toHaveTextContent(thread.title);
    expect(screen.getByLabelText('Project sessions')).toHaveTextContent(thread.title);

    await user.click(screen.getByRole('button', { name: 'New Session' }));

    expect(onNewChat).toHaveBeenCalledWith(project.id);
  });

  it('shows non-archived sessions even when the current subview is not chat', () => {
    renderSidebar({ subView: 'kanban', activeThreadId: null, threads: [{ thread }] });

    expect(screen.getByLabelText('Project sessions')).toHaveTextContent(thread.title);
  });

  it('renders each session as its own row rather than one grouped list card', () => {
    renderSidebar({
      threads: [
        { thread },
        { thread: { ...thread, id: 'thread-2', title: 'Second session' } },
      ],
    });

    const sessions = screen.getByLabelText('Project sessions');
    expect(sessions).not.toHaveClass('compact-project-session-list');
    expect(sessions.querySelectorAll('.compact-project-session-row')).toHaveLength(2);
  });

  it('uses the default sidebar width when no preference is saved', () => {
    renderSidebar();

    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' })).toHaveStyle({ width: '240px' });
  });

  it('uses the saved sidebar width when a preference exists', () => {
    localStorage.setItem('nexus.sidebar.width', '320');

    renderSidebar();

    expect(screen.getByRole('complementary', { name: 'Navigation sidebar' })).toHaveStyle({ width: '320px' });
  });

  it('resizes and persists the sidebar width within bounds', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const sidebar = screen.getByRole('complementary', { name: 'Navigation sidebar' });
    const handle = screen.getByTitle('Drag to resize sidebar');

    await user.pointer([
      { keys: '[MouseLeft>]', target: handle, coords: { clientX: 240, clientY: 20 } },
      { coords: { clientX: 420, clientY: 20 } },
      { keys: '[/MouseLeft]', coords: { clientX: 420, clientY: 20 } },
    ]);

    expect(sidebar).toHaveStyle({ width: '360px' });
    expect(localStorage.getItem('nexus.sidebar.width')).toBe('360');
  });

  it('offers an edit action for project details', async () => {
    const user = userEvent.setup();
    const onEditProject = vi.fn();
    renderSidebar({ onEditProject });

    await user.click(screen.getByTitle('Edit active project'));

    expect(onEditProject).toHaveBeenCalledWith(project);
  });

  it('confirms before deleting a project', async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSidebar({ onDeleteProject });

    await user.click(screen.getByTitle('Delete active project'));

    expect(window.confirm).toHaveBeenCalledWith('Delete this project? This cannot be undone.');
    expect(onDeleteProject).toHaveBeenCalledWith(project.id);
  });

  it('offers an archive action for sessions', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSidebar({ onArchiveThread });

    await user.click(screen.getByTitle('Archive to memory'));

    expect(window.confirm).toHaveBeenCalledWith('Archive this session to memory and delete it?');
    expect(onArchiveThread).toHaveBeenCalledWith(thread.id);
  });

  it('shows archive progress and prevents duplicate archive actions', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSidebar({ archivingThreadIds: new Set([thread.id]), onArchiveThread });

    expect(screen.getByTitle('Archiving to memory')).toBeInTheDocument();
    expect(screen.getByText('Archiving...')).toBeInTheDocument();
    expect(screen.queryByTitle('Archive to memory')).not.toBeInTheDocument();

    await user.click(screen.getByText(thread.title));

    expect(onArchiveThread).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('keeps delete separate from archive', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    const onDeleteThread = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSidebar({ onArchiveThread, onDeleteThread });

    await user.click(screen.getAllByTitle('Delete').at(-1)!);

    expect(onDeleteThread).toHaveBeenCalledWith(thread.id);
    expect(onArchiveThread).not.toHaveBeenCalled();
  });

  it('reorders projects by dragging one project rail avatar onto another', () => {
    const onReorderProjects = vi.fn();
    renderSidebar({ onReorderProjects });
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      data: new Map<string, string>(),
      setData(format: string, value: string) { this.data.set(format, value); },
      getData(format: string) { return this.data.get(format) ?? ''; },
    };

    fireEvent.dragStart(screen.getByLabelText('Switch to mywise'), { dataTransfer });
    fireEvent.drop(screen.getByLabelText('Switch to nexus'), { dataTransfer });

    expect(onReorderProjects).toHaveBeenCalledWith(['project-2', 'project-1']);
  });
});
