import { Project, Task, ChatThread, ChatMessage, Persona, PersonaConfig, Ticket } from '@nexus/shared';

const API = '/api';

export type AgentHealth = 'online' | 'ready' | 'offline';

export interface AgentStatus {
  slug: string;
  name: string;
  provider: string;
  model: string;
  status: AgentHealth;
  latencyMs?: number;
  detail?: string;
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

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
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
    createThread: (projectId: string, agentId: string) =>
      fetchJson<ChatThread>(`${API}/projects/${projectId}/threads`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) }),
    messages: (threadId: string) => fetchJson<ChatMessage[]>(`${API}/threads/${threadId}/messages`),
    sendMessage: (threadId: string, role: 'user' | 'assistant' | 'system', content: string, attachments?: string) =>
      fetchJson<ChatMessage>(`${API}/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ role, content, attachments }) }),
    archive: (threadId: string) => fetchJson<void>(`${API}/threads/${threadId}/archive`, { method: 'POST' }),
  },
  personas: {
    list: () => fetchJson<Persona[]>(`${API}/personas`),
    get: (slug: string) => fetchJson<PersonaConfig>(`${API}/personas/${slug}`),
    create: (data: PersonaConfig) => fetchJson<Persona>(`${API}/personas`, { method: 'POST', body: JSON.stringify(data) }),
    delete: (slug: string) => fetchJson<void>(`${API}/personas/${slug}`, { method: 'DELETE' }),
  },
  agents: {
    status: () => fetchJson<any>(`${API}/agents/status`),
    runs: (taskId: string) => fetchJson<any[]>(`${API}/agents/runs/${taskId}`),
    usage: (projectId?: string) => fetchJson<any>(`${API}/agents/usage${projectId ? `?projectId=${projectId}` : ''}`),
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
