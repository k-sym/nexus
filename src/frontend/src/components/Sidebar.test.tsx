import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Sidebar, { type ThreadMeta } from './Sidebar';
import type { ChatThread, Project } from '@nexus/shared';

const project: Project = {
  id: 'project-1',
  slug: 'nexus',
  name: 'nexus',
  description: '',
  repo_path: '/repo/nexus',
  config_json: '{}',
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
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

function renderSidebar(threads: ThreadMeta[] = [{ thread }], activeSessionIds = new Set<string>()) {
  return render(
    <Sidebar
      projects={[project]}
      activeProjectId={project.id}
      subView="chat"
      activeThreadId={thread.id}
      threads={threads}
      activeSessionIds={activeSessionIds}
      onSelectProject={noop}
      onSelectSubView={noop}
      onSelectThread={noop}
      onRenameThread={noop}
      onDeleteThread={noop}
      onNewChat={noop}
      onNewProject={noop}
    />,
  );
}

describe('Sidebar', () => {
  it('labels chat threads as sessions and shows active session activity', () => {
    renderSidebar([{ thread }], new Set([thread.id]));

    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.getByTitle('Session active')).toBeInTheDocument();
  });

  it('shows an empty sessions state', () => {
    renderSidebar([]);

    expect(screen.getByText('No sessions')).toBeInTheDocument();
    expect(screen.queryByText('No conversations')).not.toBeInTheDocument();
  });
});
