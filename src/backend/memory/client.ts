/**
 * HTTP client for the standalone @nexus/memory-daemon (default 127.0.0.1:4100).
 *
 * The daemon owns the canonical Obsidian vault and the rebuildable SQLite index.
 * The Nexus backend is just a client — it never touches the vault/index directly,
 * which keeps the daemon the single writer. Set MEMORY_DAEMON_URL to override.
 */
import { loadConfig } from '../config.js';

export interface DaemonRecallItem {
  id: string;
  title: string | null;
  namespace: string;
  project: string | null;
  category?: string | null;
  source: string;
  score: number;
  sentences: { id: number; text: string; score: number }[];
  parentChunks: string[];
  body?: string;
  created_at?: string;
  updated_at?: string;
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
  body?: string;
  created_at?: string;
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

export interface ReindexStats {
  scanned: number;
  inserted: number;
  updated: number;
  noop: number;
  removed: number;
  reindexed: number;
  queued: number;
}

export interface ClearNexusFailure { path: string; error: string }
export interface ClearNexusResult {
  namespace: 'nexus';
  deleted: number;
  failed: number;
  paths: string[];
  failures: ClearNexusFailure[];
  ok?: boolean;
  reconciliation?: ReindexStats | null;
  reconciliationError?: string;
}

export interface SessionArchiveSummaryRequest {
  projectName: string;
  threadTitle: string;
  transcript: string;
  /** Which prompt/shape to apply. 'single' (default) and 'synthesis' both produce
   *  the final structured summary; 'chunk' extracts durable notes from one window
   *  of an oversized transcript. See the session-archiving design spec. */
  mode?: 'single' | 'chunk' | 'synthesis';
  /** Model max_tokens override; defaults are chosen per mode on the daemon. */
  maxTokens?: number;
}

export interface SessionArchiveSummaryResponse {
  summary: string;
}

export interface SessionTitleRequest {
  prompt: string;
}

export interface SessionTitleResponse {
  title: string;
}

export interface NextMessageRequest {
  /** The conversation tail, already rendered to `User:` / `Assistant:` lines. */
  transcript: string;
}

export interface NextMessageResponse {
  /** '' means the model had nothing worth suggesting — not an error. */
  suggestion: string;
}

export class DaemonRequestError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: string) {
    super(message);
    this.name = 'DaemonRequestError';
  }
}

/** The daemon accepted the connection but produced no (complete) response in time.
 *  Deliberately not a DaemonRequestError: callers map those by HTTP status, and a
 *  timeout has none — it falls through to their generic "daemon unavailable" path. */
export class DaemonTimeoutError extends Error {
  constructor(readonly timeoutMs: number, method: string, path: string) {
    super(`Memory daemon did not respond within ${timeoutMs}ms (${method} ${path})`);
    this.name = 'DaemonTimeoutError';
  }
}

export interface DaemonRequestOptions {
  /** Upper bound for the whole request (connect, headers and body). */
  timeoutMs?: number;
}

/** Boot health probe. A wedged daemon (2026-09-07: accepting TCP, never answering)
 *  must degrade to the "unreachable at boot" warning, not block app.listen(). */
export const HEALTH_TIMEOUT_MS = 5_000;
/** Ordinary reads/writes and the short generation calls; the daemon's own caps for
 *  those are 30 s or less (embed/title/next-message), so this only trips on a wedge. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** rebuild-index, clear-nexus (reconciles the index) and archive summaries, which the
 *  daemon caps at 300 s per generation call. */
export const HEAVY_TIMEOUT_MS = 600_000;

function daemonUrl(): string {
  return process.env.MEMORY_DAEMON_URL || loadConfig().memory.daemon_url || 'http://127.0.0.1:4100';
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Pull the daemon's deliberate `detail` string off an error response, if present. */
async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json() as { detail?: unknown } | null;
    const detail = body?.detail;
    return typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 400) : undefined;
  } catch {
    return undefined;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

async function req<T>(method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  // AbortSignal.timeout also covers the body read, so a daemon that sends headers
  // and then stalls is bounded too.
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${daemonUrl()}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (isTimeout(err)) throw new DaemonTimeoutError(timeoutMs, method, path);
    throw err;
  }
  if (!res.ok) {
    // Status is enough for callers to preserve validation/conflict semantics.
    // Deliberately do not forward an arbitrary daemon body or stack trace — only
    // the one field the daemon sets on purpose, capped, since the daemon may be a
    // remote thin-client target rather than loopback.
    const detail = await readErrorDetail(res);
    const message = res.status === 409
      ? 'Memory maintenance already running'
      : res.status === 400
        ? 'Memory daemon rejected request'
        : 'Memory daemon request failed';
    throw new DaemonRequestError(res.status, message, detail);
  }
  try {
    return (res.status === 204 ? null : await res.json()) as T;
  } catch (err) {
    if (isTimeout(err)) throw new DaemonTimeoutError(timeoutMs, method, path);
    throw err;
  }
}

export const daemon = {
  store(input: { namespace: string; project?: string | null; category?: string | null; source: string; title?: string; body: string; metadata?: Record<string, unknown> }) {
    return req<{ id: string; action: string }>('POST', '/memories', input);
  },
  recall(query: string, scope: DaemonScope = {}, limit?: number) {
    return req<DaemonRecallResponse>('POST', '/recall', { query, ...scope, limit });
  },
  list(scope: DaemonScope = {}, limit?: number) {
    return req<{ items: DaemonListItem[] }>('GET', `/memories${qs({ ...scope, limit })}`);
  },
  search(query: string, scope: DaemonScope = {}, limit?: number) {
    return req<DaemonRecallResponse>('GET', `/memories${qs({ q: query, ...scope, limit })}`);
  },
  update(id: string, patch: { title?: string; body?: string }) {
    return req<unknown>('PUT', `/memories/${encodeURIComponent(id)}`, patch);
  },
  remove(id: string) {
    return req<unknown>('DELETE', `/memories/${encodeURIComponent(id)}`);
  },
  health(opts: DaemonRequestOptions = {}) {
    return req<DaemonHealth>('GET', '/health', undefined, opts.timeoutMs ?? HEALTH_TIMEOUT_MS);
  },
  rebuildIndex(opts: DaemonRequestOptions = {}) {
    return req<ReindexStats>('POST', '/operations/rebuild-index', undefined, opts.timeoutMs ?? HEAVY_TIMEOUT_MS);
  },
  clearNexusMemory(confirmation: string, opts: DaemonRequestOptions = {}) {
    return req<ClearNexusResult>('POST', '/operations/clear-nexus', { confirmation }, opts.timeoutMs ?? HEAVY_TIMEOUT_MS);
  },
  summarizeSessionArchive(input: SessionArchiveSummaryRequest, opts: DaemonRequestOptions = {}) {
    return req<SessionArchiveSummaryResponse>('POST', '/operations/summarize-session-archive', input, opts.timeoutMs ?? HEAVY_TIMEOUT_MS);
  },
  generateSessionTitle(input: SessionTitleRequest) {
    return req<SessionTitleResponse>('POST', '/operations/generate-session-title', input);
  },
  generateNextMessage(input: NextMessageRequest) {
    return req<NextMessageResponse>('POST', '/operations/generate-next-message', input);
  },
};
