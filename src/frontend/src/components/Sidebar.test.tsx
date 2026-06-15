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
  activeSessionIds = new Set<string>(),
  onEditProject = noop,
  onDeleteProject = noop,
  onReorderProjects = noop,
}: {
  threads?: ThreadMeta[];
  activeSessionIds?: Set<string>;
  onEditProject?: (project: Project) => void;
  onDeleteProject?: (projectId: string) => void;
  onReorderProjects?: (projectIds: string[]) => void;
} = {}) {
  return render(
    <Sidebar
      projects={[project, secondProject]}
      activeProjectId={project.id}
      subView="chat"
      activeThreadId={thread.id}
      threads={threads}
      activeSessionIds={activeSessionIds}
      projectCounts={{
        [project.id]: { tasks: 3, sessions: threads.length },
        [secondProject.id]: { tasks: 10, sessions: 2 },
      }}
      onSelectProject={noop}
      onSelectSubView={noop}
      onSelectThread={noop}
      onRenameThread={noop}
      onDeleteThread={noop}
      onNewChat={noop}
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

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.getByTitle('Session active')).toBeInTheDocument();
  });

  it('shows an empty sessions state', () => {
    renderSidebar({ threads: [] });

    expect(screen.getByText('No sessions')).toBeInTheDocument();
    expect(screen.queryByText('No conversations')).not.toBeInTheDocument();
  });

  it('shows project, kanban, and sessions counts in the drawer', () => {
    renderSidebar({ threads: [{ thread }, { thread: { ...thread, id: 'thread-2', title: 'Second session' } }] });

    expect(screen.getByText('3/2')).toBeInTheDocument();
    expect(screen.getByText('10/2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
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

    await user.click(screen.getAllByTitle('Edit project')[0]);

    expect(onEditProject).toHaveBeenCalledWith(project);
  });

  it('confirms before deleting a project', async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSidebar({ onDeleteProject });

    await user.click(screen.getAllByTitle('Delete project')[0]);

    expect(window.confirm).toHaveBeenCalledWith('Delete this project? This cannot be undone.');
    expect(onDeleteProject).toHaveBeenCalledWith(project.id);
  });

  it('reorders projects by dragging one project onto another', () => {
    const onReorderProjects = vi.fn();
    renderSidebar({ onReorderProjects });
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      data: new Map<string, string>(),
      setData(format: string, value: string) { this.data.set(format, value); },
      getData(format: string) { return this.data.get(format) ?? ''; },
    };

    fireEvent.dragStart(screen.getByText('mywise').closest('button')!, { dataTransfer });
    fireEvent.drop(screen.getByText('nexus').closest('button')!, { dataTransfer });

    expect(onReorderProjects).toHaveBeenCalledWith(['project-2', 'project-1']);
  });
});
