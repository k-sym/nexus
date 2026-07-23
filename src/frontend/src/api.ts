/**
 * Frontend API client.
 *
 * The chat thread, persona, provider, and OAuth surfaces are gone.
 * Each thread is now a pi-runtime-backed session; auth lives in
 * ~/.nexus/auth.json; the model registry is the curated pi list.
 */
import { Project, Task, ChatThread, Ticket, TicketDescription, BraindumpIdea, GitDiffState, ReviewActionRequest, ReviewActionResult, Mission, MissionRun, CreateMissionInput, UpdateMissionInput, MondayItem, MondayItemWithLinks, TaskMondayLink, MondayProjectConfig } from '@nexus/shared';
export type { GitDiffState, ReviewActionRequest, ReviewActionResult } from '@nexus/shared';
import { apiFetch } from './api-base';
import type { QuestionAnswer } from './lib/questions';

export type AgentHealth = 'online' | 'ready' | 'offline';

export interface MissionStatus {
  memory: {
    ok: boolean;
    status?: string;
    memories?: number;
    jobs?: { pending: number; dead: number };
    models?: { gen: boolean; embed: boolean; rerank: boolean };
    error?: string;
  };
  models: Array<{ provider: string; id: string; name: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; configured: boolean }>;
  modelCounts?: { active: number; available: number };
  stats?: Record<'claude' | 'codex' | 'openrouter', {
    ok: boolean;
    value: string;
    caption: string;
    windows?: Partial<Record<'session' | 'weekly', { usedPercent: number; remainingPercent: number; resetLabel?: string; resetsAt?: string; windowMinutes?: number }>>;
    source?: string;
    sampledAt?: string;
    error?: string;
  }>;
}

export interface NotificationItem {
  id: string;
  level: 'info' | 'error';
  title: string;
  message: string;
  created_at: string;
}

export interface ModelsResponse {
  models: any[];
  allModels: any[];
  enabledModelKeys: string[];
  customized: boolean;
}

export interface LocalModelTestRequest {
  base_url: string;
  api_key: string;
  chat_model: string;
}

export interface LocalModelTestResponse {
  ok: boolean;
  message: string;
  models: string[];
  modelFound?: boolean;
}

export type OperationKind = 'chat_turn' | 'assistant_stream' | 'jira_sync' | 'github_sync' | 'memory_archive' | 'memory_index';
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  title: string;
  project_id: string | null;
  task_id: string | null;
  thread_id: string | null;
  provider: string | null;
  model: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  usage?: unknown;
  last_event: string | null;
  error: string | null;
  diagnostics?: unknown;
}

export interface ActivityResponse {
  running: Operation[];
  recent: Operation[];
  counts: Record<string, number>;
}

export interface ActiveChatRunsResponse {
  activeThreadIds: string[];
  runs: Array<{
    threadId: string;
    title: string;
    modelKey: string;
    projectId: string | null;
    waitingForResponse: boolean;
    questionCount: number;
  }>;
}

/** One live (non-archived) session, from any project. */
export interface ChatSessionSummary {
  threadId: string;
  projectId: string;
  title: string;
  updatedAt: string;
}

export interface ChatSessionsResponse {
  sessions: ChatSessionSummary[];
}

export type SecretSource = 'environment' | 'config-env-reference' | 'config-literal' | 'pi-auth-file' | 'gh-cli' | 'absent' | 'unknown';

export interface TrustSecret {
  configured: boolean;
  source: SecretSource;
  location?: string;
  credentialType?: 'api_key' | 'oauth';
}

export interface TrustSnapshot {
  services: Array<{ name: string; url: string; loopback: boolean }>;
  storage: Array<{ name: string; path: string; role: 'canonical' | 'rebuildable' | 'application' | 'credentials' | 'configuration' }>;
  secrets: Record<string, TrustSecret>;
  memory: {
    namespaces: string[];
    recall: { mode: 'on_demand'; tool: string; maxMemories: number; tokenBudget: number };
    archive: { mode: 'manual'; destination: string; removesHotThreadAfterSuccess: true };
  };
  outbound: Array<{ name: string; destination: string; sends: string[]; enabled: boolean }>;
  telemetry: { applicationTelemetry: false; statement: string };
}

export interface ReindexResult {
  scanned: number;
  inserted: number;
  updated: number;
  noop: number;
  removed: number;
  reindexed: number;
  queued: number;
}

export type FilePreview =
  | { path: string; name: string; mimeType: string; kind: 'text'; size: number; content: string }
  | { path: string; name: string; mimeType: string; kind: 'image'; size: number; data: string }
  | { path: string; name: string; mimeType: string; kind: 'pdf'; size: number; url: string }
  | { path: string; name: string; mimeType: string; kind: 'unsupported'; size: number; reason?: string };

export interface ClearNexusResult {
  namespace: 'nexus';
  deleted: number;
  failed: number;
  paths: string[];
  failures: Array<{ path: string; error: string }>;
  ok?: boolean;
  reconciliation?: ReindexResult | null;
  reconciliationError?: string;
}

export interface MemoryRecord {
  id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** An Error thrown by `fetchJson` for a non-ok response. `code`/`retryable` are
 *  attached only when the backend's error body carried them (e.g. Monday's
 *  502 `{ error, code, retryable }`) — callers that don't care can keep
 *  treating this as a plain `Error`. */
export interface FetchJsonError extends Error {
  code?: string;
  retryable?: boolean;
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects no-body DELETE/POST requests with 400 ("body cannot be empty").
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  const res = await apiFetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: FetchJsonError = new Error((body as any).error || res.statusText);
    if (typeof (body as any).code === 'string') err.code = (body as any).code;
    if (typeof (body as any).retryable === 'boolean') err.retryable = (body as any).retryable;
    throw err;
  }
  return res.json() as Promise<T>;
}

// Monday.com — the Project Management view's read paths and link CRUD.
// Free-standing exports (not nested under `api`) so ProjectManagementView can
// import and mock them directly, matching the Task 11 brief's client surface.
export async function fetchMondayItems(projectId: string, refresh = false): Promise<MondayItemWithLinks[]> {
  const query = refresh ? '?refresh=1' : '';
  const data = await fetchJson<{ items: MondayItemWithLinks[] }>(`/api/monday/projects/${projectId}/items${query}`);
  return data.items;
}

export async function searchMondayItems(projectId: string, query: string): Promise<MondayItem[]> {
  const data = await fetchJson<{ items: MondayItem[] }>(
    `/api/monday/projects/${projectId}/search?q=${encodeURIComponent(query)}`,
  );
  return data.items;
}

export async function fetchMondayLinks(projectId: string): Promise<TaskMondayLink[]> {
  const data = await fetchJson<{ links: TaskMondayLink[] }>(`/api/monday/projects/${projectId}/links`);
  return data.links;
}

export async function linkTaskToMondayItem(projectId: string, taskId: string, itemId: string): Promise<void> {
  await fetchJson(`/api/monday/links`, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, task_id: taskId, item_id: itemId }),
  });
}

export async function unlinkTaskFromMondayItem(taskId: string): Promise<void> {
  await fetchJson(`/api/monday/links/${taskId}`, { method: 'DELETE' });
}

// Task 15 — per-project Monday scope configuration. Free-standing exports
// for the same reason as the block above: MondayScopeSettings imports and
// mocks these directly.
export interface MondayBoardSummary {
  id: string;
  name: string;
  workspace: string | null;
}

export interface MondayBoardMetaResult {
  groups: Array<{ id: string; title: string }>;
  columns: Array<{ id: string; title: string; type: string }>;
}

export async function fetchMondayBoards(): Promise<MondayBoardSummary[]> {
  const data = await fetchJson<{ boards: MondayBoardSummary[] }>(`/api/monday/boards`);
  return data.boards;
}

export async function fetchMondayBoardMeta(boardId: string): Promise<MondayBoardMetaResult> {
  return fetchJson<MondayBoardMetaResult>(`/api/monday/boards/${encodeURIComponent(boardId)}/meta`);
}

export async function fetchMondayProjectConfig(projectId: string): Promise<MondayProjectConfig | null> {
  const data = await fetchJson<{ config: MondayProjectConfig | null }>(`/api/monday/projects/${projectId}/config`);
  return data.config;
}

export async function saveMondayProjectConfig(projectId: string, config: MondayProjectConfig): Promise<MondayProjectConfig> {
  const data = await fetchJson<{ config: MondayProjectConfig }>(`/api/monday/projects/${projectId}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
  return data.config;
}

export const api = {
  projects: {
    list: () => fetchJson<Project[]>(`/api/projects`),
    get: (id: string) => fetchJson<Project>(`/api/projects/${id}`),
    create: (data: { name: string; badge?: string; repo_path: string }) =>
      fetchJson<Project>(`/api/projects`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Project, 'name' | 'badge' | 'repo_path' | 'config_json'>>) =>
      fetchJson<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    reorder: (projectIds: string[]) =>
      fetchJson<Project[]>(`/api/projects/order`, { method: 'PUT', body: JSON.stringify({ project_ids: projectIds }) }),
    delete: (id: string) => fetchJson<void>(`/api/projects/${id}`, { method: 'DELETE' }),
    tasks: (id: string) => fetchJson<Task[]>(`/api/projects/${id}/tasks`),
    createTask: (id: string, data: { title: string; description?: string; status?: string; priority?: string; assigned_agent?: string }) =>
      fetchJson<Task>(`/api/projects/${id}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
    githubSync: (id: string) =>
      fetchJson<{ created: number; total: number }>(`/api/projects/${id}/github/sync`, { method: 'POST' }),
    gitDiff: (id: string) => fetchJson<GitDiffState>(`/api/projects/${id}/git/diff`),
    previewFile: (id: string, path: string) =>
      fetchJson<FilePreview>(`/api/projects/${id}/files/preview?path=${encodeURIComponent(path)}`),
    reviewAction: (id: string, data: ReviewActionRequest) =>
      fetchJson<ReviewActionResult>(`/api/projects/${id}/review-actions`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  tasks: {
    update: (id: string, data: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assigned_agent' | 'due_date' | 'model_key' | 'thread_id'>>) =>
      fetchJson<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  },
  chat: {
    threads: (projectId: string) => fetchJson<ChatThread[]>(`/api/projects/${projectId}/threads`),
    activeRuns: () => fetchJson<ActiveChatRunsResponse>(`/api/chat/active-runs`),
    // Every live session across all projects, running or not.
    sessions: () => fetchJson<ChatSessionsResponse>(`/api/chat/sessions`),
    // Creates a thread. Threads don't bind to a persona any more.
    // The optional `title` sets the initial title (defaults to "New Session").
    createThread: (projectId: string, title?: string) =>
      fetchJson<ChatThread>(`/api/projects/${projectId}/threads`, {
        method: 'POST',
        body: JSON.stringify(title ? { title } : {}),
      }),
    renameThread: (threadId: string, title: string) =>
      fetchJson<ChatThread>(`/api/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    archiveThread: (threadId: string) => fetchJson<{ memoryId: string | null }>(`/api/threads/${threadId}/archive`, { method: 'POST' }),
    deleteThread: (threadId: string) => fetchJson<void>(`/api/threads/${threadId}`, { method: 'DELETE' }),
    answerQuestion: (threadId: string, toolCallId: string, answers: QuestionAnswer[]) =>
      fetchJson<{ ok: true }>(
        `/api/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(toolCallId)}/answer`,
        { method: 'POST', body: JSON.stringify({ answers }) },
      ),
  },
  models: {
    list: () => fetchJson<ModelsResponse>(`/api/models`),
    saveCuration: (enabledModelKeys: string[]) =>
      fetchJson<ModelsResponse>(`/api/models/curation`, {
        method: 'PUT',
        body: JSON.stringify({ enabledModelKeys }),
      }),
    setActive: (provider: string, model: string) =>
      fetchJson<{ ok: boolean }>(`/api/models/active`, {
        method: 'POST',
        body: JSON.stringify({ provider, model }),
      }),
  },
  settings: {
    get: () => fetchJson<any>(`/api/settings`),
    update: (config: any) => fetchJson<any>(`/api/settings`, { method: 'PUT', body: JSON.stringify(config) }),
    testLocalModel: (data: LocalModelTestRequest) =>
      fetchJson<LocalModelTestResponse>(`/api/settings/local-model/test`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  trust: {
    get: () => fetchJson<TrustSnapshot>('/api/trust'),
    rebuildMemory: () => fetchJson<ReindexResult>('/api/trust/memory/rebuild', { method: 'POST' }),
    clearNexusMemory: (confirmation: string) => fetchJson<ClearNexusResult>('/api/trust/memory/clear-nexus', {
      method: 'POST',
      body: JSON.stringify({ confirmation }),
    }),
  },
  missionControl: {
    get: () => fetchJson<MissionStatus>(`/api/mission-control`),
  },
  tickets: {
    list: () => fetchJson<Ticket[]>(`/api/tickets`),
    description: (key: string, refresh = false) =>
      fetchJson<TicketDescription>(`/api/tickets/${encodeURIComponent(key)}/description${refresh ? '?refresh=1' : ''}`),
  },
  braindump: {
    list: () => fetchJson<BraindumpIdea[]>(`/api/braindump`),
    create: (data: { title: string; body?: string }) =>
      fetchJson<BraindumpIdea>(`/api/braindump`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<BraindumpIdea, 'title' | 'body' | 'status' | 'project_id' | 'task_id'>>) =>
      fetchJson<BraindumpIdea>(`/api/braindump/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`/api/braindump/${id}`, { method: 'DELETE' }),
  },
  missions: {
    listForProject: (projectId: string) => fetchJson<Mission[]>(`/api/projects/${projectId}/missions`),
    create: (projectId: string, input: CreateMissionInput) =>
      fetchJson<Mission>(`/api/projects/${projectId}/missions`, { method: 'POST', body: JSON.stringify(input) }),
    get: (id: string) => fetchJson<Mission>(`/api/missions/${id}`),
    update: (id: string, input: UpdateMissionInput) =>
      fetchJson<Mission>(`/api/missions/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
    delete: (id: string) => fetchJson<void>(`/api/missions/${id}`, { method: 'DELETE' }),
    resume: (id: string) => fetchJson<Mission>(`/api/missions/${id}/resume`, { method: 'POST' }),
    pause: (id: string) => fetchJson<Mission>(`/api/missions/${id}/pause`, { method: 'POST' }),
    stop: (id: string) => fetchJson<Mission>(`/api/missions/${id}/stop`, { method: 'POST' }),
    runs: (id: string) => fetchJson<MissionRun[]>(`/api/missions/${id}/runs`),
  },
  assistant: {
    thread: () => fetchJson<{ id: 'global'; messages: any[] }>(`/api/assistant/thread`),
    sessions: () =>
      fetchJson<{ sessions: Array<{ id: string; status?: string; latestRun?: { status?: string } | null }> }>(
        `/api/assistant/sessions`,
      ),
  },
  notifications: {
    list: () => fetchJson<NotificationItem[]>(`/api/notifications`),
    seen: (ids: string[]) =>
      fetchJson<{ ok: boolean }>(`/api/notifications/seen`, { method: 'POST', body: JSON.stringify({ ids }) }),
  },
  memory: {
    search: (projectId: string, query: string) => fetchJson<MemoryRecord[]>(`/api/projects/${projectId}/memories?q=${encodeURIComponent(query)}`),
    list: (projectId: string) => fetchJson<MemoryRecord[]>(`/api/projects/${projectId}/memories`),
    create: (projectId: string, data: { content: string; category?: string; agent_id?: string }) =>
      fetchJson<any>(`/api/projects/${projectId}/memories`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { content: string }) =>
      fetchJson<void>(`/api/memories/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`/api/memories/${id}`, { method: 'DELETE' }),
  },
  activity: {
    list: (params?: { status?: string; kind?: string; limit?: number }) =>
      fetchJson<ActivityResponse>(`/api/activity${qs(params ?? {})}`),
    get: (id: string) => fetchJson<Operation>(`/api/activity/${id}`),
    abort: (id: string) => fetchJson<{ ok: boolean }>(`/api/activity/${id}/abort`, { method: 'POST' }),
    retry: (id: string) => fetchJson<{ ok: boolean }>(`/api/activity/${id}/retry`, { method: 'POST' }),
    diagnostics: (id: string) =>
      fetchJson<{ diagnostics?: unknown; lastEvent?: string; error?: string }>(`/api/activity/${id}/diagnostics`),
  },
};
