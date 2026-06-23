/**
 * Frontend API client.
 *
 * The chat thread, persona, provider, and OAuth surfaces are gone.
 * Each thread is now a pi-runtime-backed session; auth lives in
 * ~/.nexus/auth.json; the model registry is the curated pi list.
 */
import { Project, Task, ChatThread, Ticket, TicketDescription, BraindumpIdea, GitDiffState, ReviewActionRequest, ReviewActionResult, Mission, MissionRun, CreateMissionInput, UpdateMissionInput } from '@nexus/shared';
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
  stats?: Record<'claude' | 'codex' | 'openrouter', {
    ok: boolean;
    value: string;
    caption: string;
    windows?: Partial<Record<'session' | 'weekly', { usedPercent: number; remainingPercent: number; resetLabel?: string; resetsAt?: string; windowMinutes?: number }>>;
    source?: string;
    sampledAt?: string;
    error?: string;
  }>;
  activity: { running: any[]; recent: any[] };
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
    autoInject: { enabled: boolean; maxMemories: number; tokenBudget: number };
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

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
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
    throw new Error((body as any).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  projects: {
    list: () => fetchJson<Project[]>(`/api/projects`),
    get: (id: string) => fetchJson<Project>(`/api/projects/${id}`),
    create: (data: { name: string; description?: string; repo_path: string }) =>
      fetchJson<Project>(`/api/projects`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Project, 'name' | 'description' | 'repo_path' | 'config_json'>>) =>
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
  },
  notifications: {
    list: () => fetchJson<NotificationItem[]>(`/api/notifications`),
    seen: (ids: string[]) =>
      fetchJson<{ ok: boolean }>(`/api/notifications/seen`, { method: 'POST', body: JSON.stringify({ ids }) }),
  },
  memory: {
    search: (projectId: string, query: string) => fetchJson<string[]>(`/api/projects/${projectId}/memories?q=${encodeURIComponent(query)}`),
    list: (projectId: string) => fetchJson<any[]>(`/api/projects/${projectId}/memories`),
    create: (projectId: string, data: { content: string; category?: string; agent_id?: string }) =>
      fetchJson<any>(`/api/projects/${projectId}/memories`, { method: 'POST', body: JSON.stringify(data) }),
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
