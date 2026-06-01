/**
 * HTTP client for the standalone @nexus/memory-daemon (default 127.0.0.1:4100).
 *
 * The daemon owns the canonical Obsidian vault and the rebuildable SQLite index.
 * The Nexus backend is just a client — it never touches the vault/index directly,
 * which keeps the daemon the single writer. Set MEMORY_DAEMON_URL to override.
 */
import { loadConfig } from '../config';

export interface DaemonRecallItem {
  id: string;
  title: string | null;
  namespace: string;
  project: string | null;
  source: string;
  score: number;
  sentences: { id: number; text: string; score: number }[];
  parentChunks: string[];
  facts?: { subject: string; relation: string; object: string }[];
}

export interface DaemonRecallResponse {
  query: string;
  degraded: boolean;
  items: DaemonRecallItem[];
  context?: string;
}

export interface DaemonListItem {
  id: string;
  title: string | null;
  namespace: string;
  project: string | null;
  category: string | null;
  source: string;
  updated_at: string;
}

export interface DaemonHealth {
  status: string;
  vault?: string;
  db?: string;
  memories?: number;
  jobs?: { pending: number; dead: number };
  models?: { gen: boolean; embed: boolean; rerank: boolean };
}

export interface DaemonScope {
  namespace?: string;
  project?: string | null;
  category?: string | null;
  scope?: 'isolated' | 'cross';
}

function daemonUrl(): string {
  return process.env.MEMORY_DAEMON_URL || loadConfig().memory.daemon_url || 'http://127.0.0.1:4100';
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${daemonUrl()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`memory-daemon ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

export const daemon = {
  store(input: { namespace: string; project?: string | null; category?: string | null; source: string; title?: string; body: string }) {
    return req<{ id: string; action: string }>('POST', '/memories', input);
  },
  recall(query: string, scope: DaemonScope = {}, limit?: number) {
    return req<DaemonRecallResponse>('POST', '/recall', { query, ...scope, limit });
  },
  list(scope: DaemonScope = {}, limit?: number) {
    return req<{ items: DaemonListItem[] }>('GET', `/memories${qs({ ...scope, limit })}`);
  },
  update(id: string, patch: { title?: string; body?: string }) {
    return req<unknown>('PUT', `/memories/${encodeURIComponent(id)}`, patch);
  },
  remove(id: string) {
    return req<unknown>('DELETE', `/memories/${encodeURIComponent(id)}`);
  },
  health() {
    return req<DaemonHealth>('GET', '/health');
  },
};
