/**
 * Unified "open sessions" for the glasses cockpit.
 *
 * Merges Nexus's two session stores into the single flat `SessionSummary[]`
 * the glasses expect:
 *   - project chat threads (id + title + project, live/waiting from the
 *     in-process active-runs feed, everything else from the DB), and
 *   - Assistant sessions (project-less, DB-persisted run status).
 *
 * "live/waiting" for chat threads lives in the main app's process memory
 * (`threadRunClaims` + `QuestionBroker`), reachable only via its HTTP surface,
 * so we read it back over loopback from `/api/chat/active-runs`. Everything
 * else is a direct DB read.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PiRuntime } from '../pi/runtime.js';
import { flattenEntries } from '../routes/chat.js';
import { messagesToTranscriptEvents, toMs, waitingAttention } from './mappers.js';
import type { SessionDetail, SessionSummary } from './types.js';

const RUNNING_STATUSES = new Set(['running', 'cancelling']);
/** Mirrors assistant-session.ts ASSISTANT_CWD without importing its internals. */
const ASSISTANT_CWD = join(homedir(), '.nexus', 'assistant');

/** Minimal structural DB type (better-sqlite3 satisfies this). */
interface Db {
  prepare(sql: string): {
    get(...args: unknown[]): any;
    all(...args: unknown[]): any;
    run(...args: unknown[]): any;
  };
}

export interface GatewayDeps {
  db: Db;
  pi: PiRuntime;
  mainPort: number;
  /** Resolved main-backend bearer token, attached to loopback reads when set. */
  mainToken?: string;
  recentMs: number;
}

/** Authorization header for loopback calls into the token-gated main backend. */
function authHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

export type Scope = 'active' | 'recent' | 'all';

interface ActiveRun {
  threadId: string;
  title: string;
  modelKey: string;
  projectId: string | null;
  waitingForResponse: boolean;
  questionCount: number;
}

/** Read the main app's in-process active/waiting chat runs over loopback. */
async function fetchActiveRuns(mainPort: number, mainToken?: string): Promise<Map<string, ActiveRun>> {
  try {
    const res = await fetch(`http://127.0.0.1:${mainPort}/api/chat/active-runs`, {
      headers: authHeaders(mainToken),
    });
    if (!res.ok) return new Map();
    const data = (await res.json()) as { runs?: ActiveRun[] };
    return new Map((data.runs ?? []).map((run) => [run.threadId, run]));
  } catch {
    return new Map();
  }
}

interface ChatThreadRow {
  id: string;
  title: string;
  updated_at: string;
  project_id: string;
  project_name: string;
  repo_path: string;
}

interface AssistantSessionRow {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

export async function buildSessions(deps: GatewayDeps, scope: Scope = 'active'): Promise<SessionSummary[]> {
  const now = Date.now();
  const runByThread = await fetchActiveRuns(deps.mainPort, deps.mainToken);

  const threadRows = deps.db
    .prepare(`
      SELECT t.id, t.title, t.updated_at, t.project_id, p.name AS project_name, p.repo_path
      FROM chat_threads t
      JOIN projects p ON p.id = t.project_id
      WHERE t.archived_at IS NULL
      ORDER BY t.updated_at DESC
    `)
    .all() as ChatThreadRow[];

  const chatSessions: SessionSummary[] = threadRows.map((row) => {
    const run = runByThread.get(row.id);
    const waiting = run?.waitingForResponse ?? false;
    const lastActivityAt = toMs(row.updated_at) ?? now;
    return {
      id: row.id,
      kind: 'chat',
      projectId: row.project_id,
      title: run?.title || row.title || 'Session',
      cwd: row.repo_path || '',
      project: row.project_name || '',
      lastPrompt: '',
      lastAssistant: '',
      turns: 0,
      lastActivityAt,
      live: !!run,
      recent: now - lastActivityAt < deps.recentMs,
      needsAttention: waiting,
      attention: waiting ? waitingAttention() : null,
    };
  });

  const assistantRows = deps.db
    .prepare('SELECT id, title, status, updated_at FROM assistant_sessions WHERE archived_at IS NULL ORDER BY updated_at DESC')
    .all() as AssistantSessionRow[];

  const assistantSessions: SessionSummary[] = assistantRows.map((row) => {
    const latest = deps.db
      .prepare('SELECT status, updated_at FROM assistant_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(row.id) as { status: string; updated_at: string } | undefined;
    const running = RUNNING_STATUSES.has(row.status) || (!!latest && RUNNING_STATUSES.has(latest.status));
    const lastActivityAt = Math.max(toMs(row.updated_at) ?? 0, toMs(latest?.updated_at) ?? 0) || now;
    return {
      id: row.id,
      kind: 'assistant',
      projectId: null,
      title: row.title || 'Assistant Session',
      cwd: ASSISTANT_CWD,
      project: 'Assistant',
      lastPrompt: '',
      lastAssistant: '',
      turns: 0,
      lastActivityAt,
      live: running,
      recent: now - lastActivityAt < deps.recentMs,
      needsAttention: false,
      attention: null,
    };
  });

  const all = [...chatSessions, ...assistantSessions];
  const filtered =
    scope === 'all'
      ? all
      : scope === 'recent'
        ? all.filter((s) => s.recent || s.needsAttention)
        : all.filter((s) => s.live || s.needsAttention || s.recent);
  return filtered.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export type ResolvedSession =
  | { kind: 'chat'; threadId: string; cwd: string }
  | { kind: 'assistant'; sessionId: string; cwd: string };

/** Map a cockpit session id back to its Nexus store + cwd. */
export function resolveSession(db: Db, id: string): ResolvedSession | null {
  const thread = db
    .prepare('SELECT p.repo_path AS repo_path FROM chat_threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?')
    .get(id) as { repo_path: string } | undefined;
  if (thread) return { kind: 'chat', threadId: id, cwd: thread.repo_path || process.cwd() };
  const assistant = db.prepare('SELECT id FROM assistant_sessions WHERE id = ?').get(id) as { id: string } | undefined;
  if (assistant) return { kind: 'assistant', sessionId: id, cwd: ASSISTANT_CWD };
  return null;
}

/** Read a session's recent transcript as glasses `TranscriptEvent[]`. */
async function readEvents(deps: GatewayDeps, resolved: ResolvedSession) {
  if (resolved.kind === 'chat') {
    const entries = await deps.pi.readMessages(resolved.threadId, resolved.cwd);
    const flattened = entries.length > 0 ? flattenEntries(entries, resolved.cwd, {}) : [];
    return messagesToTranscriptEvents(flattened);
  }
  // Assistant transcript lives behind the main app's assistant route (its
  // reader + legacy-seed logic is module-private), so read it over loopback.
  try {
    const res = await fetch(
      `http://127.0.0.1:${deps.mainPort}/api/assistant/sessions/${encodeURIComponent(resolved.sessionId)}`,
      { headers: authHeaders(deps.mainToken) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: unknown[] };
    return messagesToTranscriptEvents(data.messages ?? []);
  } catch {
    return [];
  }
}

/** Full detail for one session: its summary + last ~40 transcript events. */
export async function buildDetail(deps: GatewayDeps, id: string): Promise<SessionDetail | null> {
  const resolved = resolveSession(deps.db, id);
  if (!resolved) return null;
  const [sessions, events] = await Promise.all([buildSessions(deps, 'all'), readEvents(deps, resolved)]);
  const session = sessions.find((s) => s.id === id) ?? null;
  if (!session) return null;
  return { session, events };
}
