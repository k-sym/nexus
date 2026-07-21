import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar, { type ThreadMeta, type SidebarSession } from './Sidebar';
import { confirmDialog } from '../lib/confirm';
import type { ChatThread, Project } from '@nexus/shared';

vi.mock('../lib/confirm', () => ({ confirmDialog: vi.fn() }));

const project: Project = {
  id: 'project-1',
  slug: 'nexus',
  name: 'nexus',
  badge: 'NEX',
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
  badge: 'MYW',
  repo_path: '/repo/mywise',
};

const thread: ChatThread = {
  id: 'thread-1',
  project_id: project.id,
  title: 'Inspect progress docs first',
  git_branch: 'feat/session-icons',
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
  archived_at: null,
};

const noop = vi.fn();

function renderSidebar({
  threads = [{ thread }],
  subView = 'chat',
  activeThreadId = thread.id,
  workingSessionIds = new Set<string>(),
  waitingSessionIds = new Set<string>(),
  workingProjectIds = new Set<string>(),
  waitingProjectIds = new Set<string>(),
  liveProjectIds = new Set<string>(),
  sessions = [],
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
  workingSessionIds?: Set<string>;
  waitingSessionIds?: Set<string>;
  workingProjectIds?: Set<string>;
  waitingProjectIds?: Set<string>;
  liveProjectIds?: Set<string>;
  sessions?: SidebarSession[];
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
      workingSessionIds={workingSessionIds}
      waitingSessionIds={waitingSessionIds}
      workingProjectIds={workingProjectIds}
      waitingProjectIds={waitingProjectIds}
      liveProjectIds={liveProjectIds}
      sessions={sessions}
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
    vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
  });

  it('labels chat threads as sessions and marks a working session red', () => {
    renderSidebar({ threads: [{ thread }], workingSessionIds: new Set([thread.id]) });

    expect(screen.getByLabelText('Project sessions')).toHaveTextContent('Inspect progress docs first');
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.getByTitle('Session model working')).toHaveClass('bg-red-500');
  });

  it('badges a live session with nothing running as green idle', () => {
    renderSidebar({ threads: [{ thread }] });

    expect(screen.getByTitle('Session idle')).toHaveClass('bg-emerald-400');
    expect(screen.queryByTitle('Session model working')).not.toBeInTheDocument();
  });

  it('shows the amber waiting marker in place of the working badge', () => {
    renderSidebar({
      threads: [{ thread }],
      workingSessionIds: new Set([thread.id]),
      waitingSessionIds: new Set([thread.id]),
    });

    expect(screen.getByTitle('Session waiting for input')).toHaveClass('bg-amber-400');
    expect(screen.queryByTitle('Session model working')).not.toBeInTheDocument();
  });

  it('badges the project rail green for live sessions, red while working, amber while waiting', () => {
    renderSidebar({ liveProjectIds: new Set([project.id, secondProject.id]) });
    expect(screen.getByTitle(`${project.name}: idle`)).toHaveClass('bg-emerald-400');
    // The green dot is what lets you see, without switching, that the OTHER
    // project has sessions at all.
    expect(screen.getByTitle(`${secondProject.name}: idle`)).toHaveClass('bg-emerald-400');

    cleanup();
    renderSidebar({
      liveProjectIds: new Set([project.id]),
      workingProjectIds: new Set([project.id]),
    });
    expect(screen.getByTitle(`${project.name}: model working`)).toHaveClass('bg-red-500');

    cleanup();
    renderSidebar({
      liveProjectIds: new Set([project.id]),
      workingProjectIds: new Set([project.id]),
      waitingProjectIds: new Set([project.id]),
    });
    expect(screen.getByTitle(`${project.name}: waiting for input`)).toHaveClass('bg-amber-400');
  });

  it('leaves the rail undotted for a project with no live sessions', () => {
    renderSidebar({ liveProjectIds: new Set([project.id]) });

    expect(screen.queryByTitle(`${secondProject.name}: idle`)).not.toBeInTheDocument();
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
    // The rail shows the stored 3-char badge, not a bare initial (#230).
    expect(screen.getByTitle('nexus')).toHaveTextContent('NEX');
    expect(screen.getByTitle('mywise')).toHaveTextContent('MYW');
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
      workingSessionIds: new Set([thread.id]),
      waitingSessionIds: new Set([waitingThread.id]),
      sessions: [
        { threadId: thread.id, title: thread.title, projectId: project.id, activity: 'working' },
        { threadId: waitingThread.id, title: waitingThread.title, projectId: project.id, activity: 'waiting' },
      ],
    });

    const activeSection = screen.getByLabelText('Active sessions');
    expect(activeSection).toHaveTextContent('Inspect progress docs first');
    expect(activeSection).toHaveTextContent('RUN');
    expect(activeSection).toHaveTextContent('Waiting on approval');
    expect(activeSection).toHaveTextContent('WAIT');
  });

  it('docks active sessions above the version label without a fixed list height', () => {
    renderSidebar({
      sessions: [
        { threadId: thread.id, title: thread.title, projectId: project.id, activity: 'idle' },
      ],
    });

    const activeSection = screen.getByLabelText('Active sessions');
    expect(activeSection).not.toHaveClass('mt-auto');
    expect(activeSection).toHaveClass('min-h-0');
    expect(activeSection.querySelector('.overflow-y-auto')).not.toHaveClass('max-h-56');
    expect(activeSection.nextElementSibling).toHaveTextContent('v0.1.0 · Personal');
  });

  it('keeps a finished session in the active sessions list, badged IDLE', () => {
    // The whole point of the list: a session does not vanish when its run ends.
    // It only leaves on delete/archive, which drops it from `sessions` upstream.
    renderSidebar({
      threads: [{ thread }],
      sessions: [
        { threadId: thread.id, title: thread.title, projectId: project.id, activity: 'idle' },
      ],
    });

    const activeSection = screen.getByLabelText('Active sessions');
    expect(activeSection).toHaveTextContent('Inspect progress docs first');
    expect(activeSection).toHaveTextContent('IDLE');
    expect(activeSection).not.toHaveTextContent('RUN');
  });

  it('orders the list waiting first, then working, then idle', () => {
    renderSidebar({
      sessions: [
        { threadId: 'idle-1', title: 'Idle session', projectId: project.id, activity: 'idle' },
        { threadId: 'work-1', title: 'Working session', projectId: project.id, activity: 'working' },
        { threadId: 'wait-1', title: 'Waiting session', projectId: project.id, activity: 'waiting' },
      ],
    });

    const titles = within(screen.getByLabelText('Active sessions'))
      .getAllByRole('button')
      .map((el) => el.textContent);
    expect(titles).toEqual([
      expect.stringContaining('Waiting session'),
      expect.stringContaining('Working session'),
      expect.stringContaining('Idle session'),
    ]);
  });

  it('shows sessions from OTHER projects (global), so they stay visible after navigating away', () => {
    // Session lives in secondProject while the user is viewing `project`.
    renderSidebar({
      sessions: [
        { threadId: 'other-1', title: 'Long build in other project', projectId: secondProject.id, activity: 'working' },
      ],
    });

    const activeSection = screen.getByLabelText('Active sessions');
    expect(activeSection).toHaveTextContent('Long build in other project');
    expect(activeSection).toHaveTextContent('RUN');
    // Labeled with the owning project's name, not the currently-viewed one.
    expect(activeSection).toHaveTextContent(secondProject.name);
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

  it('shows a branch awareness icon on session rows', () => {
    renderSidebar();

    expect(screen.getByTitle('Branch: feat/session-icons')).toBeInTheDocument();
  });

  it('shows a muted branch icon when branch detection is unavailable', () => {
    renderSidebar({ threads: [{ thread: { ...thread, git_branch: '' } }] });

    expect(screen.getByTitle('Branch unavailable')).toBeInTheDocument();
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
    renderSidebar({ onDeleteProject });

    await user.click(screen.getByTitle('Delete active project'));

    expect(confirmDialog).toHaveBeenCalledWith('Delete this project? This cannot be undone.');
    await waitFor(() => expect(onDeleteProject).toHaveBeenCalledWith(project.id));
  });

  it('offers an archive action for sessions', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    renderSidebar({ onArchiveThread });

    await user.click(screen.getByTitle('Archive to memory'));

    expect(confirmDialog).toHaveBeenCalledWith('Archive this session to memory and delete it?');
    await waitFor(() => expect(onArchiveThread).toHaveBeenCalledWith(thread.id));
  });

  it('shows archive progress and prevents duplicate archive actions', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    renderSidebar({ archivingThreadIds: new Set([thread.id]), onArchiveThread });

    expect(screen.getByTitle('Archiving to memory')).toBeInTheDocument();
    expect(screen.getByText('Archiving...')).toBeInTheDocument();
    expect(screen.queryByTitle('Archive to memory')).not.toBeInTheDocument();

    await user.click(screen.getByText(thread.title));

    expect(onArchiveThread).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('keeps delete separate from archive', async () => {
    const user = userEvent.setup();
    const onArchiveThread = vi.fn();
    const onDeleteThread = vi.fn();
    renderSidebar({ onArchiveThread, onDeleteThread });

    await user.click(screen.getAllByTitle('Delete').at(-1)!);

    await waitFor(() => expect(onDeleteThread).toHaveBeenCalledWith(thread.id));
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
