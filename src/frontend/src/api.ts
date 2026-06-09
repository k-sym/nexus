import { Project, Task, ChatThread, ChatMessage, Persona, PersonaConfig, Ticket, Provider, Reply, FileAttachment, ChatStreamEvent } from '@nexus/shared';

export interface ProviderTestResult { ok: boolean; detail: string; latencyMs?: number }

// Dev: '/api' is proxied to :4173 by vite. Prod (Electron file://): the preload
// exposes an absolute base via __NEXUS_API__ so cross-origin /api calls resolve.
const API = (globalThis as unknown as { __NEXUS_API__?: string }).__NEXUS_API__ ?? '/api';

/** Build the ws:// URL for a thread's PTY, derived from the API base. */
export function ptyWsUrl(threadId: string): string {
  const httpBase = API.startsWith('http')
    ? API
    : `${window.location.origin}${API.startsWith('/') ? API : `/${API}`}`;
  const wsBase = httpBase.replace(/^http/, 'ws');
  return `${wsBase}/threads/${threadId}/pty`;
}

export type AgentHealth = 'online' | 'ready' | 'offline';

export interface AgentStatus {
  slug: string;
  name: string;
  provider: string;
  model: string;
  status: AgentHealth;
  latencyMs?: number;
  detail?: string;
  icon?: string;
  color: string;
}

/** A persona row enriched with its parsed visual identity (icon/color) by the backend. */
export interface PersonaWithVisual extends Persona {
  icon?: string;
  color: string;
}

export interface MissionStatus {
  memory: {
    ok: boolean;
    status?: string;
    memories?: number;
    jobs?: { pending: number; dead: number };
    models?: { gen: boolean; embed: boolean; rerank: boolean };
    error?: string;
  };
  scheduler: { enabled: boolean; intervalSeconds: number; schedules: number; lastRun: string | null; nextRun: string | null };
  agents: AgentStatus[];
  activity: { running: any[]; recent: any[] };
}

export interface NotificationItem {
  id: string;
  level: 'info' | 'error';
  title: string;
  message: string;
  created_at: string;
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  // Only send a JSON content-type when there's actually a body — otherwise
  // Fastify rejects no-body DELETE/POST requests with 400 ("body cannot be empty").
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  projects: {
    list: () => fetchJson<Project[]>(`${API}/projects`),
    get: (id: string) => fetchJson<Project>(`${API}/projects/${id}`),
    create: (data: { name: string; description?: string; repo_path: string }) =>
      fetchJson<Project>(`${API}/projects`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Project, 'name' | 'description' | 'repo_path' | 'config_json'>>) =>
      fetchJson<Project>(`${API}/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`${API}/projects/${id}`, { method: 'DELETE' }),
    tasks: (id: string) => fetchJson<Task[]>(`${API}/projects/${id}/tasks`),
    createTask: (id: string, data: { title: string; description?: string; status?: string; priority?: string; assigned_agent?: string }) =>
      fetchJson<Task>(`${API}/projects/${id}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  },
  tasks: {
    update: (id: string, data: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assigned_agent' | 'due_date'>>) =>
      fetchJson<Task>(`${API}/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`${API}/tasks/${id}`, { method: 'DELETE' }),
  },
  chat: {
    threads: (projectId: string) => fetchJson<ChatThread[]>(`${API}/projects/${projectId}/threads`),
    createThread: (projectId: string, agentId: string, mode: 'chat' | 'terminal' = 'chat', launchCommand?: string | null) =>
      fetchJson<ChatThread>(`${API}/projects/${projectId}/threads`, { method: 'POST', body: JSON.stringify({ agent_id: agentId, mode, launch_command: launchCommand ?? null }) }),
    messages: (threadId: string) => fetchJson<ChatMessage[]>(`${API}/threads/${threadId}/messages`),
    // Posts the user's turn; the backend runs the thread's agent and returns the assistant reply.
    sendMessage: (threadId: string, content: string, attachments?: string) =>
      fetchJson<ChatMessage>(`${API}/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ content, attachments }) }),
    // Submits the user's selection for a question card; backend runs the continuation turn.
    answer: (threadId: string, questionMessageId: string, replies: Reply[]) =>
      fetchJson<ChatMessage>(`${API}/threads/${threadId}/answer`, { method: 'POST', body: JSON.stringify({ question_message_id: questionMessageId, replies }) }),
    renameThread: (threadId: string, title: string) =>
      fetchJson<ChatThread>(`${API}/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    archive: (threadId: string) => fetchJson<void>(`${API}/threads/${threadId}/archive`, { method: 'POST' }),
    deleteThread: (threadId: string) => fetchJson<void>(`${API}/threads/${threadId}`, { method: 'DELETE' }),
    // Opens a macOS Terminal in the project repo, resuming this thread's Claude session.
    openTerminal: (threadId: string) => fetchJson<{ ok: boolean }>(`${API}/threads/${threadId}/open-terminal`, { method: 'POST' }),
    // Persists dropped files (base64) under the project's project_docs/uploads/; returns saved attachments.
    upload: (threadId: string, files: { name: string; mime_type: string; data_base64: string }[]) =>
      fetchJson<FileAttachment[]>(`${API}/threads/${threadId}/upload`, { method: 'POST', body: JSON.stringify({ files }) }),
    // Exports a chat thread as a JSONL file (Phase 4: session export).
    export: (threadId: string) =>
      fetchJson<{ ok: boolean; path: string }>(`${API}/threads/${threadId}/export`, { method: 'POST' }),
    // Aborts a running generation for this thread (Phase 2: executor registry).
    abort: (threadId: string) =>
      fetchJson<{ ok: boolean }>(`${API}/threads/${threadId}/abort`, { method: 'POST' }),
    // Sends a message and streams the turn: calls onEvent for each delta/session/done/error.
    sendMessageStream: async (
      threadId: string,
      content: string,
      attachments: string,
      onEvent: (ev: ChatStreamEvent) => void,
    ): Promise<void> => {
      const res = await fetch(`${API}/threads/${threadId}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, attachments }),
      });
      if (!res.ok || !res.body) throw new Error(`Stream failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line) as ChatStreamEvent); } catch { /* skip partial/garbage */ }
        }
      }
    },
  },
  personas: {
    list: () => fetchJson<PersonaWithVisual[]>(`${API}/personas`),
    get: (slug: string) => fetchJson<PersonaConfig>(`${API}/personas/${slug}`),
    launchCommand: (slug: string) => fetchJson<{ command: string }>(`${API}/personas/${slug}/launch-command`),
    create: (data: PersonaConfig) => fetchJson<Persona>(`${API}/personas`, { method: 'POST', body: JSON.stringify(data) }),
    delete: (slug: string) => fetchJson<void>(`${API}/personas/${slug}`, { method: 'DELETE' }),
  },
  agents: {
    status: () => fetchJson<any>(`${API}/agents/status`),
    runs: (taskId: string) => fetchJson<any[]>(`${API}/agents/runs/${taskId}`),
    usage: (projectId?: string) => fetchJson<any>(`${API}/agents/usage${projectId ? `?projectId=${projectId}` : ''}`),
    // Sets a model on a task and moves it to in_progress; the orchestrator
    // picks it up on the next poll tick and dispatches headlessly.
    startTask: (taskId: string, modelKey: string) =>
      fetchJson<{ ok: boolean }>(`${API}/orchestrator/tasks/${taskId}/start`, {
        method: 'POST',
        body: JSON.stringify({ modelKey }),
      }),
  },
  models: {
    list: () => fetchJson<{ models: any[] }>(`${API}/models`),
    setActive: (provider: string, model: string) =>
      fetchJson<{ ok: boolean }>(`${API}/models/active`, {
        method: 'POST',
        body: JSON.stringify({ provider, model }),
      }),
  },
  settings: {
    get: () => fetchJson<any>(`${API}/settings`),
    update: (config: any) => fetchJson<any>(`${API}/settings`, { method: 'PUT', body: JSON.stringify(config) }),
  },
  missionControl: {
    get: () => fetchJson<MissionStatus>(`${API}/mission-control`),
  },
  tickets: {
    list: () => fetchJson<Ticket[]>(`${API}/tickets`),
  },
  notifications: {
    list: () => fetchJson<NotificationItem[]>(`${API}/notifications`),
    seen: (ids: string[]) =>
      fetchJson<{ ok: boolean }>(`${API}/notifications/seen`, { method: 'POST', body: JSON.stringify({ ids }) }),
  },
  providers: {
    list: () => fetchJson<Provider[]>(`${API}/providers`),
    create: (data: Partial<Provider>) => fetchJson<Provider>(`${API}/providers`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Provider>) => fetchJson<Provider>(`${API}/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`${API}/providers/${id}`, { method: 'DELETE' }),
    test: (id: string) => fetchJson<ProviderTestResult>(`${API}/providers/${id}/test`, { method: 'POST' }),
    // Discover available models for a provider (claude_code / codex / http).
    discoverModels: (id: string) => fetchJson<{ models: string[] }>(`${API}/providers/${id}/discover-models`),
  },
  auth: {
    status: () => fetchJson<{
      providers: Array<{ id: string; name: string; oauthSupported: boolean; loggedIn: boolean; hasCredential: boolean; credentialType: string | null }>;
      inFlight: string | null;
    }>(`${API}/auth/status`),
    // Starts an OAuth flow; returns the response. Events stream as NDJSON — use
    // the raw fetch + reader for streaming rather than fetchJson.
    startOAuth: async (
      providerId: string,
      onEvent: (ev: { kind: string; [k: string]: unknown }) => void,
    ): Promise<void> => {
      const res = await fetch(`${API}/auth/oauth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId }),
      });
      if (!res.ok || !res.body) throw new Error(`OAuth start failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    },
    cancelOAuth: () => fetchJson<{ ok: boolean }>(`${API}/auth/oauth/cancel`, { method: 'POST' }),
    logout: (providerId: string) => fetchJson<{ ok: boolean }>(`${API}/auth/logout`, { method: 'POST', body: JSON.stringify({ providerId }) }),
  },
  memory: {
    search: (projectId: string, query: string) => fetchJson<string[]>(`${API}/projects/${projectId}/memories?q=${encodeURIComponent(query)}`),
    list: (projectId: string) => fetchJson<any[]>(`${API}/projects/${projectId}/memories`),
    create: (projectId: string, data: { content: string; category?: string; agent_id?: string }) =>
      fetchJson<any>(`${API}/projects/${projectId}/memories`, { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`${API}/memories/${id}`, { method: 'DELETE' }),
  },
  schedules: {
    list: (projectId: string) => fetchJson<any[]>(`${API}/projects/${projectId}/schedules`),
    create: (projectId: string, data: { name: string; cron_expr: string; task_template: string; task_description?: string; agent_id: string }) =>
      fetchJson<any>(`${API}/projects/${projectId}/schedules`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ name: string; cron_expr: string; task_template: string; task_description: string; agent_id: string; enabled: boolean }>) =>
      fetchJson<any>(`${API}/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`${API}/schedules/${id}`, { method: 'DELETE' }),
  },
};
