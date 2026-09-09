import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardResponse, ChatThread, Project } from '@nexus/shared';

const mockApi = vi.hoisted(() => ({
  missionControl: { get: vi.fn() },
  activity: { list: vi.fn() },
  projects: {
    list: vi.fn(),
    board: vi.fn(),
    boardDraft: vi.fn(),
    boardSession: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    gitDiff: vi.fn(),
    reviewAction: vi.fn(),
  },
  chat: {
    threads: vi.fn(),
    activeRuns: vi.fn(),
    sessions: vi.fn(),
    createThread: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn(),
    deleteThread: vi.fn(),
  },
}));

vi.mock('./api', () => ({ api: mockApi, fetchMondayItems: vi.fn().mockResolvedValue(null) }));
vi.mock('./hooks/useModels', () => ({
  modelKey: (provider: string, id: string) => `${provider}/${id}`,
  useModels: () => ({
    models: [{ provider: 'claude-code', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
    activeModelId: 'claude-code/claude-sonnet-5',
  }),
}));
// Captures the most recent ChatPanel props so a test can invoke a callback
// exactly as a since-unmounted panel instance would (a stale closure).
const chatPanelProps = vi.hoisted(() => ({ current: null as null | { projectId: string; threadId: string | null; onThreadsChanged?: () => void } }));
vi.mock('./components/ChatPanel', () => ({
  default: (props: { projectId: string; threadId: string | null; onThreadsChanged?: () => void }) => {
    chatPanelProps.current = props;
    return <div data-testid="chat-panel-props">{props.projectId}:{props.threadId ?? 'none'}</div>;
  },
}));
vi.mock('./components/AssistantView', () => ({
  default: () => <div data-testid="assistant-view">Assistant</div>,
}));
vi.mock('./components/IdeasView', () => ({
  default: () => <div data-testid="ideas-view">Ideas</div>,
}));
vi.mock('./components/MemoryRail', () => ({ default: () => <div data-testid="memory-rail" /> }));
vi.mock('./components/ProjectManagementView', () => ({
  ProjectManagementView: ({ projectId }: { projectId: string }) => (
    <div data-testid="project-management-view">{projectId}</div>
  ),
}));
vi.mock('./components/DaemonToasts', () => ({ default: () => null }));
vi.mock('./components/NotificationToasts', () => ({ default: () => null }));

import App from './App';

const projects: Project[] = [
  {
    id: 'project-a',
    slug: 'a',
    name: 'Alpha',
    badge: 'ALP',
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
    badge: 'BET',
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

const betaThread: ChatThread = {
  id: 'thread-beta',
  project_id: 'project-b',
  title: 'Beta session',
  created_at: '2026-06-26T00:00:00.000Z',
  updated_at: '2026-06-26T00:00:00.000Z',
  archived_at: null,
};

const emptyBoard: BoardResponse = { cards: [], inbox: [], inbox_errors: {} };

const alphaBoard: BoardResponse = {
  cards: [{
    thread: alphaThread,
    lane: 'idle',
    origin: { kind: 'chat' },
    running: false,
    pending_questions: 0,
    pending_approvals: 0,
    monday_item_id: null,
  }],
  inbox: [{
    kind: 'github', id: '439', title: 'Session-first Kanban',
    url: 'https://github.com/k-sym/nexus/issues/439', labels: [], status_label: null, updated: null,
  }],
  inbox_errors: {},
};

describe('App project navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.missionControl.get.mockResolvedValue({ memory: { ok: true }, models: [] });
    mockApi.activity.list.mockResolvedValue({ running: [], recent: [], counts: {} });
    mockApi.projects.list.mockResolvedValue(projects);
    mockApi.projects.board.mockResolvedValue(emptyBoard);
    mockApi.chat.activeRuns.mockResolvedValue({ activeThreadIds: [], runs: [] });
    mockApi.chat.sessions.mockResolvedValue({ sessions: [] });
    mockApi.chat.threads.mockImplementation(async (projectId: string) => (
      projectId === 'project-a' ? [alphaThread] : []
    ));
  });

  // Regression: the rail once sourced every dot from /api/chat/sessions alone, so
  // a backend without that route left it completely dark while the session rows
  // kept badging correctly off the run feed — status was invisible until you
  // clicked into each project, which is the problem the rail exists to solve.
  it('lights the rail from the run feed when the session list is unavailable', async () => {
    mockApi.chat.sessions.mockRejectedValue(new Error('Route GET:/api/chat/sessions not found'));
    mockApi.chat.activeRuns.mockResolvedValue({
      activeThreadIds: ['thread-alpha', 'thread-beta'],
      runs: [
        { threadId: 'thread-alpha', title: 'Alpha session', modelKey: 'anthropic/opus',
          projectId: 'project-a', waitingForResponse: false, questionCount: 0 },
        { threadId: 'thread-beta', title: 'Beta session', modelKey: 'anthropic/opus',
          projectId: 'project-b', waitingForResponse: true, questionCount: 1 },
      ],
    });

    render(<App />);

    expect(await screen.findByTitle('Alpha: model working')).toHaveClass('bg-red-500');
    expect(await screen.findByTitle('Beta: waiting for input')).toHaveClass('bg-amber-400');
  });

  it('falls back to the project session count for the green rail dot', async () => {
    mockApi.chat.sessions.mockRejectedValue(new Error('Route GET:/api/chat/sessions not found'));

    render(<App />);

    // Alpha has chat_session_count 1, Beta has 0 — so only Alpha is dotted.
    expect(await screen.findByTitle('Alpha: idle')).toHaveClass('bg-emerald-400');
    await waitFor(() => {
      expect(screen.queryByTitle('Beta: idle')).not.toBeInTheDocument();
    });
  });

  it('still lists a running session when the session list is unavailable', async () => {
    mockApi.chat.sessions.mockRejectedValue(new Error('Route GET:/api/chat/sessions not found'));
    mockApi.chat.activeRuns.mockResolvedValue({
      activeThreadIds: ['thread-beta'],
      runs: [
        { threadId: 'thread-beta', title: 'Beta session', modelKey: 'anthropic/opus',
          projectId: 'project-b', waitingForResponse: false, questionCount: 0 },
      ],
    });

    render(<App />);

    const section = await screen.findByLabelText('Active sessions');
    expect(section).toHaveTextContent('Beta session');
    expect(section).toHaveTextContent('RUN');
  });


  // Regression: a stream started in project A keeps its transport open after
  // the user switches to project B (ChatPanel is keyed on the project, so the
  // A instance unmounts, but the backend run — and the fetch reading it — carry
  // on). When that run finished, the dead instance's `onThreadsChanged` reloaded
  // A's thread list into App while B was active; the ghost-thread guard then saw
  // B's open thread missing from "the" list and deselected it, blanking the
  // composer and whatever had been typed into it.
  it('ignores a thread-list reload for a project that is no longer active', async () => {
    mockApi.chat.threads.mockImplementation(async (projectId: string) => (
      projectId === 'project-a' ? [alphaThread] : projectId === 'project-b' ? [betaThread] : []
    ));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByText('Alpha session'));
    expect(await screen.findByTestId('chat-panel-props')).toHaveTextContent('project-a:thread-alpha');
    const staleOnThreadsChanged = chatPanelProps.current?.onThreadsChanged;
    expect(staleOnThreadsChanged).toBeTypeOf('function');

    await user.click(screen.getByLabelText('Switch to Beta'));
    await user.click(await screen.findByText('Beta session'));
    expect(await screen.findByTestId('chat-panel-props')).toHaveTextContent('project-b:thread-beta');

    // The run in Alpha completes: the unmounted panel's closure fires.
    await act(async () => { staleOnThreadsChanged?.(); });
    await waitFor(() => expect(mockApi.chat.threads).toHaveBeenCalledWith('project-a'));

    // Beta's thread stays selected and Beta's tree still lists Beta's sessions.
    await waitFor(() => {
      expect(screen.getByTestId('chat-panel-props')).toHaveTextContent('project-b:thread-beta');
    });
    expect(screen.getByText('Beta session')).toBeInTheDocument();
    expect(screen.queryByText('Alpha session')).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: /confirm/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed');

    await user.click(screen.getByTitle('Dismiss archive error'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the Project Management sub-view for the active project', async () => {
    const user = userEvent.setup();
    localStorage.clear();
    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByText('Project Management'));

    expect(await screen.findByTestId('project-management-view')).toHaveTextContent('project-a');
  });

  it('hides the Projects sidebar on the Assistant view', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByLabelText('Navigation sidebar')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Partner/i }));

    expect(await screen.findByTestId('assistant-view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Navigation sidebar')).not.toBeInTheDocument();
  });

  it('hides the Projects sidebar on the Ideas view', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByLabelText('Navigation sidebar')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ideas/i }));

    expect(await screen.findByTestId('ideas-view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Navigation sidebar')).not.toBeInTheDocument();
  });
});

describe('App session-first board (#439)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockApi.missionControl.get.mockResolvedValue({ memory: { ok: true }, models: [] });
    mockApi.activity.list.mockResolvedValue({ running: [], recent: [], counts: {} });
    mockApi.projects.list.mockResolvedValue(projects);
    mockApi.projects.board.mockImplementation(async (projectId: string) => (projectId === 'project-a' ? alphaBoard : emptyBoard));
    mockApi.chat.activeRuns.mockResolvedValue({ activeThreadIds: [], runs: [] });
    mockApi.chat.sessions.mockResolvedValue({ sessions: [] });
    mockApi.chat.threads.mockImplementation(async (projectId: string) => (projectId === 'project-a' ? [alphaThread] : []));
  });

  it('loads the board projection on the Kanban view and opens a card as its session', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByRole('button', { name: /^Kanban/ }));

    await waitFor(() => expect(mockApi.projects.board).toHaveBeenCalledWith('project-a'));
    const card = (await screen.findAllByText('Alpha session')).find((el) => el.closest('[data-kanban-card]'))!;
    expect(card).toBeTruthy();
    expect(screen.getByText('GH #439')).toBeInTheDocument();
    // No task routes anywhere on the way in.
    expect((mockApi.projects as Record<string, unknown>).tasks).toBeUndefined();

    await user.click(card);
    expect(await screen.findByTestId('chat-panel-props')).toHaveTextContent('project-a:thread-alpha');
  });

  it('opens the origin panel for an Inbox item and Go opens the new session seeded with the first turn', async () => {
    const newThread: ChatThread = { ...alphaThread, id: 'thread-439', title: '#439 Session-first Kanban', github_issue: 439 };
    mockApi.projects.boardSession.mockResolvedValue({ thread: newThread, firstTurn: 'Composed first turn' });
    mockApi.chat.threads.mockImplementation(async (projectId: string) => (projectId === 'project-a' ? [alphaThread, newThread] : []));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByRole('button', { name: /^Kanban/ }));
    await user.click(await screen.findByText('Session-first Kanban'));

    const panel = await screen.findByTestId('origin-session-panel');
    expect(panel).toHaveTextContent('GitHub issue #439');
    expect((within(panel).getByLabelText('Project') as HTMLSelectElement).value).toBe('project-a');

    await user.type(within(panel).getByLabelText('Prompt'), 'Make cards sessions');
    await user.type(within(panel).getByLabelText('Branch name'), 'feat/session-first-kanban');
    await user.click(within(panel).getByRole('button', { name: /^go$/i }));

    await waitFor(() => expect(mockApi.projects.boardSession).toHaveBeenCalledWith('project-a', {
      kind: 'github',
      id: '439',
      projectId: 'project-a',
      problem: 'Make cards sessions',
      branchName: 'feat/session-first-kanban',
    }));
    expect(await screen.findByTestId('chat-panel-props')).toHaveTextContent('project-a:thread-439');
    expect(screen.queryByTestId('origin-session-panel')).toBeNull();
  });

  it('the board "+" and the palette "New idea" both jump to the Ideas view', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Switch to Alpha'));
    await user.click(await screen.findByRole('button', { name: /^Kanban/ }));
    await user.click(await screen.findByRole('button', { name: 'New idea' }));
    expect(await screen.findByTestId('ideas-view')).toBeInTheDocument();
  });
});
