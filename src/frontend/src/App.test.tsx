import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatThread, Project } from '@nexus/shared';

const mockApi = vi.hoisted(() => ({
  missionControl: { get: vi.fn() },
  activity: { list: vi.fn() },
  projects: {
    list: vi.fn(),
    tasks: vi.fn(),
    githubSync: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    createTask: vi.fn(),
    gitDiff: vi.fn(),
    reviewAction: vi.fn(),
  },
  chat: {
    threads: vi.fn(),
    activeRuns: vi.fn(),
    createThread: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn(),
    deleteThread: vi.fn(),
  },
  tasks: { update: vi.fn(), delete: vi.fn() },
}));

vi.mock('./api', () => ({ api: mockApi }));
vi.mock('./components/ChatPanel', () => ({
  default: ({ projectId, threadId }: { projectId: string; threadId: string | null }) => (
    <div data-testid="chat-panel-props">{projectId}:{threadId ?? 'none'}</div>
  ),
}));
vi.mock('./components/MemoryRail', () => ({ default: () => <div data-testid="memory-rail" /> }));
vi.mock('./components/DaemonToasts', () => ({ default: () => null }));
vi.mock('./components/NotificationToasts', () => ({ default: () => null }));

import App from './App';

const projects: Project[] = [
  {
    id: 'project-a',
    slug: 'a',
    name: 'Alpha',
    description: '',
    repo_path: '/tmp/alpha',
    config_json: '{}',
    git_remote: '',
    task_count: 0,
    chat_session_count: 1,
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:00:00.000Z',
  },
  {
    id: 'project-b',
    slug: 'b',
    name: 'Beta',
    description: '',
    repo_path: '/tmp/beta',
    config_json: '{}',
    git_remote: '',
    task_count: 0,
    chat_session_count: 0,
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:00:00.000Z',
  },
];

const alphaThread: ChatThread = {
  id: 'thread-alpha',
  project_id: 'project-a',
  title: 'Alpha session',
  created_at: '2026-06-26T00:00:00.000Z',
  updated_at: '2026-06-26T00:00:00.000Z',
  archived_at: null,
};

describe('App project navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi.missionControl.get.mockResolvedValue({ memory: { ok: true }, models: [] });
    mockApi.activity.list.mockResolvedValue({ running: [], recent: [], counts: {} });
    mockApi.projects.list.mockResolvedValue(projects);
    mockApi.projects.tasks.mockResolvedValue([]);
    mockApi.projects.githubSync.mockResolvedValue({ created: 0, total: 0 });
    mockApi.chat.activeRuns.mockResolvedValue({ activeThreadIds: [], runs: [] });
    mockApi.chat.threads.mockImplementation(async (projectId: string) => (
      projectId === 'project-a' ? [alphaThread] : []
    ));
  });

  it('clears the selected thread when switching to a different project', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByText('Alpha session'));

    expect(await screen.findByTestId('chat-panel-props')).toHaveTextContent('project-a:thread-alpha');

    await user.click(screen.getByLabelText('Switch to Beta'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-panel-props')).toHaveTextContent('project-b:none');
    });
  });

  it('lets archive failures be dismissed', async () => {
    const user = userEvent.setup();
    mockApi.chat.archiveThread.mockRejectedValue(new Error('Load failed'));

    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByTitle('Archive to memory'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed');

    await user.click(screen.getByTitle('Dismiss archive error'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
