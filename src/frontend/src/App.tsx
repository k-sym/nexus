import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X } from '@phosphor-icons/react';
import type { Project, Ticket, ChatThread, BoardResponse, BoardCard, BoardInboxItem } from '@nexus/shared';
import { api, MissionStatus } from './api';
import { keepIfSameJson, keepIfSameSet } from './lib/stable';
import TopBar from './components/TopBar';
import CommandPalette, { Command } from './components/CommandPalette';
import Sidebar, { SubView, ThreadMeta, type SidebarSession, type SessionActivity } from './components/Sidebar';
import MissionControl from './components/MissionControl';
import TicketsView, { type TicketGoInput } from './components/TicketsView';
import IdeasView from './components/IdeasView';
import DaemonToasts from './components/DaemonToasts';
import NotificationToasts from './components/NotificationToasts';
import ConfirmHost from './components/ConfirmHost';
import ApprovalQueue from './components/ApprovalQueue';
import ToolDecisionsView from './components/ToolDecisionsView';
import NightQueueWorkshop from './components/NightQueueWorkshop';
import KanbanBoard, { inboxKey } from './components/KanbanBoard';
import OriginSessionPanel, { type OriginGoInput } from './components/OriginSessionPanel';
import ChatPanel from './components/ChatPanel';
import AssistantView from './components/AssistantView';
import MemoryView from './components/MemoryView';
import SettingsPage from './components/SettingsPage';
import { ProjectManagementView } from './components/ProjectManagementView';
import ProjectModal from './components/ProjectModal';
import MemoryRail from './components/MemoryRail';
import ActivityConsole from './components/ActivityConsole';
import DiffReviewPanel from './components/DiffReviewPanel';
import type { ActivityResponse, ChatSessionSummary, OperationKind, OperationStatus, ReviewActionResult } from './api';
import { loadViewState, saveViewState } from './viewState';

type GlobalView = 'dashboard' | 'activity' | 'tickets' | 'ideas' | 'assistant' | 'decisions' | 'nightQueue' | 'settings';

/** The slice of an in-flight run the sidebar needs: which project owns it and
 *  whether it is blocked on the user. */
interface ActiveRunSummary {
  threadId: string;
  title: string;
  projectId: string | null;
  waitingForResponse: boolean;
}

/** A seeded first turn handed to ChatPanel once a session opens from a ticket,
 *  an Inbox item or a diff hunk. (Named for the task board it outlived.) */
interface TaskSeed {
  threadId: string;
  prompt: string;
  modelKey: string;
}

/** How often the board re-reads its projection while it is on screen. */
const BOARD_POLL_MS = 5000;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  // Session-first board (#439): the projection the backend computes on read,
  // and the Inbox row whose origin panel is open beside it.
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [selectedInbox, setSelectedInbox] = useState<BoardInboxItem | null>(null);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [diffReviewThread, setDiffReviewThread] = useState<{ threadId: string; title: string } | null>(null);
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
  const [taskSeed, setTaskSeed] = useState<TaskSeed | null>(null);

  // --- navigation state -----------------------------------------------------
  const [globalView, setGlobalView] = useState<GlobalView | null>('dashboard');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => loadViewState().activeProjectId ?? null);
  const [subView, setSubView] = useState<SubView>(() => loadViewState().subView ?? 'kanban');
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => loadViewState().activeThreadId ?? null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [runningThreadIds, setRunningThreadIds] = useState<Set<string>>(() => new Set());
  const [waitingSessionIds, setWaitingSessionIds] = useState<Set<string>>(() => new Set());
  const [liveSessions, setLiveSessions] = useState<ChatSessionSummary[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRunSummary[]>([]);
  const [archivingThreadIds, setArchivingThreadIds] = useState<Set<string>>(() => new Set());
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [assistantActive, setAssistantActive] = useState(false);
  // Mirrors activeProjectId for async work that must not act on a stale
  // project once its result lands (see loadThreads).
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

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

  const loadBoard = useCallback(async (projectId: string) => {
    setBoardLoading(true);
    try {
      const data = await api.projects.board(projectId);
      // A slow response can land after the user switched projects.
      if (activeProjectIdRef.current !== projectId) return;
      setBoard((prev) => keepIfSameJson(prev, data));
    } catch (err) {
      console.error('Failed to load board:', err);
    } finally {
      setBoardLoading(false);
    }
  }, []);

  const loadThreads = useCallback(async (projectId: string) => {
    try {
      const data = await api.chat.threads(projectId);
      // A reload can land after the user has moved on to another project: a
      // stream started in a since-unmounted ChatPanel still names the project
      // it began in when it reports its turn finished. Adopting that list here
      // would make the ghost-thread guard below deselect the thread open in the
      // current project (and blank the composer with it).
      if (activeProjectIdRef.current !== projectId) return;
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
    } else {
      setActiveProject(null);
    }
  }, [activeProjectId, projects]);

  // The board is a projection, so it is re-read rather than kept in sync:
  // on entering the Kanban view, every 5 s while it is on screen and the tab
  // is visible, and whenever the run feed changes (below). Switching project
  // drops the old board and the open Inbox panel with it.
  useEffect(() => {
    setBoard(null);
    setSelectedInbox(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId || subView !== 'kanban') return;
    void loadBoard(activeProjectId);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void loadBoard(activeProjectId);
    }, BOARD_POLL_MS);
    return () => clearInterval(interval);
  }, [activeProjectId, subView, loadBoard]);

  useEffect(() => {
    setThreads([]);
    if (activeProjectId) loadThreads(activeProjectId);
  }, [activeProjectId, loadThreads]);

  const refreshActiveChatRuns = useCallback(async () => {
    try {
      const data = await api.chat.activeRuns();
      // Hand back the previous value when nothing changed: this runs every
      // 2 s and a fresh Set/array each tick re-renders the whole chat for no
      // reason (ChatPanel receives runningThreadIds as a prop).
      setRunningThreadIds((prev) => keepIfSameSet(prev, new Set(data.activeThreadIds)));
      setWaitingSessionIds((prev) => keepIfSameSet(
        prev,
        new Set(data.runs.filter((run) => run.waitingForResponse).map((run) => run.threadId)),
      ));
      setActiveRuns((prev) => keepIfSameJson(prev, data.runs.map((run) => ({
        threadId: run.threadId,
        title: run.title,
        projectId: run.projectId,
        waitingForResponse: run.waitingForResponse,
      }))));
    } catch (err) {
      console.error('Failed to load active chat runs:', err);
    }
  }, []);

  useEffect(() => {
    refreshActiveChatRuns();
    const interval = setInterval(refreshActiveChatRuns, 2000);
    return () => clearInterval(interval);
  }, [refreshActiveChatRuns]);

  // A run starting or stopping moves a card between lanes; refetch the board
  // as soon as the run feed says so rather than waiting for the next tick.
  // `runningThreadIds` only changes identity when its contents change
  // (keepIfSameSet), so this fires once per real transition. The mount render
  // is skipped: the view effect above already loads on entry.
  const runningThreadIdsRef = useRef(runningThreadIds);
  useEffect(() => {
    if (runningThreadIdsRef.current === runningThreadIds) return;
    runningThreadIdsRef.current = runningThreadIds;
    if (activeProjectId && subView === 'kanban') void loadBoard(activeProjectId);
  }, [runningThreadIds, activeProjectId, subView, loadBoard]);

  // The set of live sessions changes only on create/rename/delete/archive, so it
  // polls far more slowly than the run feed; those handlers refresh it directly.
  const refreshLiveSessions = useCallback(async () => {
    try {
      const { sessions } = await api.chat.sessions();
      setLiveSessions((prev) => keepIfSameJson(prev, sessions));
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }, []);

  useEffect(() => {
    refreshLiveSessions();
    const interval = setInterval(refreshLiveSessions, 5000);
    return () => clearInterval(interval);
  }, [refreshLiveSessions]);

  /** Join the slow session list to the fast run feed into one badge state. */
  const sidebarSessions: SidebarSession[] = useMemo(() => {
    const activityFor = (threadId: string): SessionActivity =>
      waitingSessionIds.has(threadId) ? 'waiting' : runningThreadIds.has(threadId) ? 'working' : 'idle';

    const merged: SidebarSession[] = liveSessions.map((session) => ({
      threadId: session.threadId,
      title: session.title,
      projectId: session.projectId,
      activity: activityFor(session.threadId),
    }));

    // A run can name a session the list hasn't caught up with: a thread created
    // on another device before the poll lands, or a backend too old to serve
    // /api/chat/sessions at all. Surface it rather than dropping it silently.
    const known = new Set(merged.map((session) => session.threadId));
    for (const run of activeRuns) {
      if (known.has(run.threadId)) continue;
      merged.push({
        threadId: run.threadId,
        title: run.title,
        projectId: run.projectId,
        activity: activityFor(run.threadId),
      });
    }
    return merged;
  }, [liveSessions, activeRuns, runningThreadIds, waitingSessionIds]);

  // Derived from the run feed rather than the session list, so a row badge turns
  // red the moment a turn starts instead of waiting for the slower session poll.
  const workingSessionIds = useMemo(
    () => new Set([...runningThreadIds].filter((id) => !waitingSessionIds.has(id))),
    [runningThreadIds, waitingSessionIds],
  );

  /**
   * Rail dots, deliberately sourced from more than one feed so the rail cannot go
   * dark just because one of them is unavailable:
   *   red/amber ← the run feed, which already names the owning project and is the
   *               freshest signal (2s). Independent of /api/chat/sessions, so an
   *               older backend without that route still lights up correctly.
   *   green     ← the session list, falling back to the per-project count that
   *               /api/projects already returns.
   */
  const projectIdsByActivity = useMemo(() => {
    const working = new Set<string>();
    const waiting = new Set<string>();
    const live = new Set<string>();

    for (const run of activeRuns) {
      if (!run.projectId) continue;
      if (run.waitingForResponse) waiting.add(run.projectId);
      else working.add(run.projectId);
    }

    for (const session of liveSessions) live.add(session.projectId);
    for (const project of projects) {
      if ((project.chat_session_count ?? 0) > 0) live.add(project.id);
    }
    // A project mid-run owns a live session by definition, whatever the list says.
    for (const id of waiting) live.add(id);
    for (const id of working) live.add(id);

    return { working, waiting, live };
  }, [activeRuns, liveSessions, projects]);

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

  // The sidebar consumes a flat ThreadMeta list; the new chat model has
  // no persona icon/color to surface.
  const threadMetas: ThreadMeta[] = useMemo(
    () => threads.map((t) => ({ thread: t })),
    [threads],
  );

  const sidebarProjectCounts = useMemo(() => {
    const counts = Object.fromEntries(
      projects.map((project) => [project.id, { sessions: project.chat_session_count ?? 0 }]),
    );

    if (activeProjectId) {
      counts[activeProjectId] = { sessions: threads.length };
    }

    return counts;
  }, [projects, activeProjectId, threads.length]);

  const handleCreateProject = async (data: { name: string; badge: string; repo_path: string }) => {
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

  const handleSaveProject = async (data: { name: string; badge: string; repo_path: string }) => {
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

  /** Diff review (#439 D12): opens against the card's own session. */
  const handleOpenDiffReview = (card: BoardCard) => {
    setDiffReviewThread({ threadId: card.thread.id, title: card.thread.title });
  };

  const handleDiffChatSeed = (seed: NonNullable<ReviewActionResult['seed']>) => {
    if (!activeProjectId || !seed.threadId) return;
    setDiffReviewThread(null);
    setTaskSeed({ threadId: seed.threadId, prompt: seed.prompt, modelKey: seed.modelKey ?? '' });
    selectThread(activeProjectId, seed.threadId);
  };

  /**
   * Ticket to session (#432): open a ticket-stamped thread, seed its first turn
   * with the server-composed prompt (edited problem + branch trailer) and the
   * picked model, then navigate into it.
   */
  const handleTicketGo = async (ticket: Ticket, input: TicketGoInput) => {
    const { thread, firstTurn } = await api.tickets.createSession(ticket.key, {
      projectId: input.projectId,
      problem: input.problem,
      branchName: input.branchName,
    });
    await loadThreads(input.projectId);
    setTaskSeed({ threadId: thread.id, prompt: firstTurn, modelKey: input.modelKey });
    selectThread(input.projectId, thread.id);
  };

  /**
   * Inbox item to session (#439): the board's counterpart of handleTicketGo.
   * The origin (GitHub issue or Monday item) is stamped on the thread by the
   * backend, so the item leaves the Inbox on the next board read.
   */
  const handleOriginGo = async (item: BoardInboxItem, input: OriginGoInput) => {
    if (!activeProjectId) return;
    const boardProjectId = activeProjectId;
    const { thread, firstTurn } = await api.projects.boardSession(boardProjectId, {
      kind: item.kind,
      id: item.id,
      projectId: input.projectId,
      problem: input.problem,
      branchName: input.branchName,
    });
    await loadThreads(input.projectId);
    setTaskSeed({ threadId: thread.id, prompt: firstTurn, modelKey: input.modelKey });
    setSelectedInbox(null);
    selectThread(input.projectId, thread.id);
    void loadBoard(boardProjectId);
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
    await refreshLiveSessions();
  };

  const handleArchiveThread = async (threadId: string) => {
    if (archivingThreadIds.has(threadId)) return;
    setArchiveError(null);
    setArchivingThreadIds((current) => new Set(current).add(threadId));
    try {
      await api.chat.archiveThread(threadId);
      if (threadId === activeThreadId) setActiveThreadId(null);
      if (activeProjectId) await loadThreads(activeProjectId);
      await refreshLiveSessions();
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
    await refreshLiveSessions();
  };

  const startNewSession = async (projectId: string) => {
    const thread = await api.chat.createThread(projectId);
    await loadThreads(projectId);
    await refreshLiveSessions();
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
    setRunningThreadIds((current) => {
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
      { id: 'view-ideas', label: 'Ideas', hint: 'View', keywords: 'ideas capture ripen park', run: () => selectGlobal('ideas') },
      { id: 'view-decisions', label: 'Decisions', hint: 'View', keywords: 'tool policy approval audit gated', run: () => selectGlobal('decisions') },
      { id: 'view-night-queue', label: 'Night Queue', hint: 'View', keywords: 'nightqueue readiness arm overnight issue candidate workshop bar', run: () => selectGlobal('nightQueue') },
      { id: 'view-assistant', label: 'Partner', hint: 'View', keywords: 'assistant partner hermes openclaw remote chat', run: () => selectGlobal('assistant') },
    ];
    (['kanban', 'memory', 'chat', 'projectManagement'] as const).forEach((sub) => {
      const label = sub === 'chat' ? 'Sessions' : sub === 'projectManagement' ? 'Project Management' : sub.charAt(0).toUpperCase() + sub.slice(1);
      const keywords = sub === 'projectManagement' ? 'open project monday initiatives' : 'open project';
      const pid = activeProjectId ?? projects[0]?.id;
      if (pid) cmds.push({ id: `view-${sub}`, label, hint: 'View', keywords, run: () => selectSubView(pid, sub) });
    });
    projects.forEach((p) => cmds.push({ id: `proj-${p.id}`, label: p.name, hint: 'Project', keywords: p.repo_path, run: () => focusProject(p.id) }));
    cmds.push({ id: 'act-new-project', label: 'New project…', hint: 'Action', run: openNewProjectModal });
    cmds.push({ id: 'act-new-idea', label: 'New idea…', hint: 'Action', keywords: 'kanban board task triage capture', run: () => selectGlobal('ideas') });
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
      return <TicketsView projects={projects} onGo={handleTicketGo} onOpenSession={selectThread} />;
    if (globalView === 'ideas')
      return <IdeasView projects={projects} />;
    if (globalView === 'assistant')
      return <AssistantView />;
    if (globalView === 'decisions')
      return <ToolDecisionsView />;
    if (globalView === 'nightQueue')
      return <NightQueueWorkshop />;

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

    const viewLabel = subView === 'chat' ? 'Sessions' : subView === 'projectManagement' ? 'Project Management' : subView.charAt(0).toUpperCase() + subView.slice(1);

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
            <div className="flex h-full min-h-0">
              <div className="flex-1 min-w-0 min-h-0">
                <KanbanBoard
                  board={board}
                  loading={boardLoading}
                  projectId={activeProject.id}
                  selectedInboxKey={selectedInbox ? inboxKey(selectedInbox) : null}
                  onOpenThread={(threadId) => selectThread(activeProject.id, threadId)}
                  onOpenInboxItem={(item) => setSelectedInbox((current) => (
                    current && inboxKey(current) === inboxKey(item) ? null : item
                  ))}
                  onNewIdea={() => selectGlobal('ideas')}
                  onOpenDiffReview={handleOpenDiffReview}
                />
              </div>
              {selectedInbox && (
                <OriginSessionPanel
                  projectId={activeProject.id}
                  item={selectedInbox}
                  projects={projects}
                  onGo={handleOriginGo}
                  onClose={() => setSelectedInbox(null)}
                />
              )}
            </div>
          ) : subView === 'chat' ? (
            <div className="flex h-full min-h-0">
              <div className="flex-1 min-w-0">
                <ChatPanel
                  key={activeProject.id}
                  projectId={activeProject.id}
                  threadId={activeThreadId}
                  onBusyConflict={() => {}}
                  onNavigateToThread={(id) => selectThread(activeProject.id, id)}
                  onThreadsChanged={() => { void loadThreads(activeProject.id); void refreshLiveSessions(); }}
                  onSessionActivityChange={handleSessionActivityChange}
                  backendActiveThreadIds={runningThreadIds}
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
          ) : subView === 'projectManagement' ? (
            <ProjectManagementView
              projectId={activeProject.id}
              onOpenThread={(threadId) => selectThread(activeProject.id, threadId)}
            />
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
        {globalView !== 'assistant' && globalView !== 'ideas' && (
          <Sidebar
            projects={projects}
            activeProjectId={activeProjectId}
            subView={subView}
            activeThreadId={activeThreadId}
            threads={activeProjectId ? threadMetas : []}
            workingSessionIds={workingSessionIds}
            waitingSessionIds={waitingSessionIds}
            workingProjectIds={projectIdsByActivity.working}
            waitingProjectIds={projectIdsByActivity.waiting}
            liveProjectIds={projectIdsByActivity.live}
            sessions={sidebarSessions}
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
          className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded-md border border-red-400/30 bg-red-950/80 px-4 py-3 text-sm text-red-100 shadow-lg backdrop-blur-sm"
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
            className="shrink-0 rounded-sm p-0.5 text-red-100/60 transition-colors hover:bg-red-100/10 hover:text-red-50"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />

      <DaemonToasts status={status} />
      <NotificationToasts />
      <ApprovalQueue />
      <ConfirmHost />

      {diffReviewThread && activeProjectId && (
        <DiffReviewPanel
          projectId={activeProjectId}
          thread={{ id: diffReviewThread.threadId, title: diffReviewThread.title }}
          onClose={() => setDiffReviewThread(null)}
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
    </div>
  );
}
