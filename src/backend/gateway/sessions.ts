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

/** How much of a message survives into a summary. Both consumers — the companion
 *  dashboard and the lens — show one line, and this list is polled every ~10s for
 *  every session, so shipping whole replies would bloat the payload for nobody. */
const PREVIEW_MAX = 240;

function preview(text: unknown): string {
  if (typeof text !== 'string' || !text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export interface SessionPreview {
  lastPrompt: string;
  lastAssistant: string;
  turns: number;
}

const NO_PREVIEW: SessionPreview = { lastPrompt: '', lastAssistant: '', turns: 0 };

/**
 * Reduce a transcript to its summary preview.
 *
 * Note this deliberately does NOT read the message tables. `chat_messages` holds only
 * the user side — a chat thread's assistant replies live in the pi store on disk — and
 * `assistant_session_messages` is empty in practice, its transcript coming back over
 * loopback. The transcript readers are the only place both sides exist, so previews are
 * derived from the same events the detail view uses.
 */
export function previewFromEvents(events: { kind: string; text?: string }[]): SessionPreview {
  let lastPrompt = '';
  let lastAssistant = '';
  let turns = 0;
  for (const e of events) {
    if (e.kind === 'user') {
      turns += 1;
      if ((e.text ?? '').trim()) lastPrompt = e.text as string;
    } else if (e.kind === 'assistant_text' && (e.text ?? '').trim()) {
      lastAssistant = e.text as string;
    }
  }
  return { lastPrompt: preview(lastPrompt), lastAssistant: preview(lastAssistant), turns };
}

/**
 * Previews cost a transcript read (a file for chat, a loopback call for Assistant), and
 * this list is polled every ~10s for every session. A transcript can only change when
 * the session's activity timestamp does, so that timestamp IS the cache key: steady
 * state costs nothing and only sessions that actually moved are re-read. The map is
 * rebuilt from each pass, so entries for vanished sessions can't accumulate.
 */
let previewCache = new Map<string, SessionPreview>();

async function readPreview(deps: GatewayDeps, id: string): Promise<SessionPreview> {
  try {
    const resolved = resolveSession(deps.db, id);
    if (!resolved) return NO_PREVIEW;
    return previewFromEvents(await readEvents(deps, resolved));
  } catch {
    return NO_PREVIEW; // a preview is never worth failing the whole list over
  }
}

async function attachPreviews(deps: GatewayDeps, sessions: SessionSummary[]): Promise<void> {
  const next = new Map<string, SessionPreview>();
  await Promise.all(
    sessions.map(async (s) => {
      const key = `${s.id}:${s.lastActivityAt}`;
      const p = previewCache.get(key) ?? (await readPreview(deps, s.id));
      next.set(key, p);
      s.lastPrompt = p.lastPrompt;
      s.lastAssistant = p.lastAssistant;
      s.turns = p.turns;
    }),
  );
  previewCache = next;
}

interface ChatThreadRow {
  id: string;
  title: string;
  updated_at: string;
  project_id: string;
  project_name: string;
  project_badge: string | null;
  repo_path: string;
}

interface AssistantSessionRow {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

export async function buildSessions(
  deps: GatewayDeps,
  scope: Scope = 'active',
  opts: { previews?: boolean } = {},
): Promise<SessionSummary[]> {
  const now = Date.now();
  const runByThread = await fetchActiveRuns(deps.mainPort, deps.mainToken);

  const threadRows = deps.db
    .prepare(`
      SELECT t.id, t.title, t.updated_at, t.project_id, p.name AS project_name, p.badge AS project_badge, p.repo_path
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
      // Empty only if the badge backfill hasn't run; the client derives one then.
      projectBadge: row.project_badge || undefined,
      ...NO_PREVIEW, // filled in by attachPreviews, for the sessions we actually return
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
      ...NO_PREVIEW, // filled in by attachPreviews, for the sessions we actually return
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
  const result = filtered.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  // After the filter, so a transcript is only read for a session we actually return.
  if (opts.previews !== false) await attachPreviews(deps, result);
  return result;
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
  // No previews here: the detail response carries the full transcript anyway, and
  // enriching the whole list would read every session's transcript to serve one.
  const [sessions, events] = await Promise.all([
    buildSessions(deps, 'all', { previews: false }),
    readEvents(deps, resolved),
  ]);
  const session = sessions.find((s) => s.id === id) ?? null;
  if (!session) return null;
  return { session, events };
}
