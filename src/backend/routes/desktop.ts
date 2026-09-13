/**
 * Claude Desktop session handoff (intent/2026-09-13-claude-desktop-session-handoff.md).
 *
 *   POST /api/threads/:threadId/desktop/open                       hand a Claude-engine thread to the desktop app
 *   GET  /api/projects/:id/desktop/sessions                        desktop + terminal sessions for the project's repo path
 *   POST /api/projects/:id/desktop/sessions/:sessionId/import      a Nexus thread that continues one of them
 *
 * Both directions keep one Claude Code session id live on both sides; the
 * thread's `desktop_shared_at` marks the transcript as shared (badge, delete
 * guard, reconcile around turns). The only write to the desktop app is the
 * `claude://resume` deep link.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getSessionInfo as sdkGetSessionInfo, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ChatThread, DesktopSessionSummary } from '@nexus/shared';
import { readStoredSessionIdFromFile, type ImportedSdkSession } from '../engines/claude/engine.js';
import {
  desktopStatus,
  isClaudeSessionId,
  listImportableSessions,
  openInDesktop,
  type DesktopStatus,
  type ListSessionsFn,
  type OpenUrlFn,
} from '../engines/claude/desktop.js';
import { transcriptStat } from '../engines/claude/transcript.js';
import { NEW_THREAD_TITLE } from '../sessions/auto-title.js';

/** What the routes need from the Claude engine; `EngineRegistry.get('claude-code')` provides it in production. */
export interface DesktopCapableEngine {
  importSdkSession(threadId: string, cwd: string, sessionId: string): Promise<ImportedSdkSession>;
  markSharedFromHere(threadId: string, cwd: string, sessionId: string): Promise<void>;
}

export interface RegisterDesktopRoutesOptions {
  engine?: () => DesktopCapableEngine | undefined;
  status?: () => DesktopStatus;
  openUrl?: OpenUrlFn;
  listSessions?: ListSessionsFn;
  getSessionInfo?: (sessionId: string, options: { dir: string }) => Promise<SDKSessionInfo | undefined>;
  transcriptExists?: (cwd: string, sessionId: string) => boolean;
  now?: () => Date;
}

export interface DesktopOpenResult {
  thread: ChatThread;
  url: string;
}

export interface DesktopImportResult {
  thread: ChatThread;
  appended: number;
}

export async function registerDesktopRoutes(fastify: FastifyInstance, options: RegisterDesktopRoutesOptions = {}) {
  const db = fastify.db;
  const pi = fastify.pi;
  const engine = options.engine ?? (() => {
    const registered = (fastify as any).engines?.get?.('claude-code');
    return registered && typeof registered.importSdkSession === 'function' ? (registered as DesktopCapableEngine) : undefined;
  });
  const status = options.status ?? desktopStatus;
  const getSessionInfo = options.getSessionInfo ?? ((sessionId, opts) => sdkGetSessionInfo(sessionId, opts));
  const transcriptExists = options.transcriptExists ?? ((cwd, sessionId) => transcriptStat(cwd, sessionId) !== null);
  const now = options.now ?? (() => new Date());

  const projectRepoPath = (projectId: string): string | undefined =>
    (db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(projectId) as { repo_path: string } | undefined)?.repo_path;
  const threadRow = (threadId: string): ChatThread | undefined =>
    db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;

  fastify.post('/api/threads/:threadId/desktop/open', async (request, reply): Promise<DesktopOpenResult | { kind: string; error: string }> => {
    const { threadId } = request.params as { threadId: string };
    const thread = threadRow(threadId);
    if (!thread) {
      reply.code(404);
      return { kind: 'not_found', error: 'Thread not found' };
    }
    if (!thread.last_model_key?.startsWith('claude-code/')) {
      reply.code(409);
      return { kind: 'engine_mismatch', error: 'Only Claude-engine sessions can be opened in Claude Desktop.' };
    }
    const cwd = projectRepoPath(thread.project_id);
    if (!cwd) {
      reply.code(404);
      return { kind: 'not_found', error: 'Project not found' };
    }
    if (!status().appFound) {
      reply.code(409);
      return { kind: 'desktop_unavailable', error: 'Claude Desktop is not installed on the machine running the Nexus backend.' };
    }
    const claude = engine();
    if (!claude) {
      reply.code(409);
      return { kind: 'engine_unavailable', error: 'The Claude engine is not registered.' };
    }
    const sessionId = thread.claude_session_id ?? readStoredSessionIdFromFile(pi.sessionDirFor(cwd), threadId);
    if (!sessionId) {
      reply.code(409);
      return { kind: 'no_session', error: 'Send a turn first: the session has no Claude transcript yet.' };
    }
    // Stamp and set the cursor before the deep link fires, so anything the
    // desktop writes from here on is picked up by the next reconcile.
    const sharedAt = thread.desktop_shared_at ?? now().toISOString();
    db.prepare('UPDATE chat_threads SET desktop_shared_at = ?, claude_session_id = ? WHERE id = ?').run(sharedAt, sessionId, threadId);
    if (!thread.desktop_shared_at) await claude.markSharedFromHere(threadId, cwd, sessionId);
    let url: string;
    try {
      url = await openInDesktop(sessionId, options.openUrl);
    } catch (err: any) {
      reply.code(502);
      return { kind: 'open_failed', error: `Could not open Claude Desktop: ${err?.message ?? err}` };
    }
    return { thread: threadRow(threadId)!, url };
  });

  fastify.get('/api/projects/:id/desktop/sessions', async (request, reply): Promise<{ sessions: DesktopSessionSummary[]; desktop: DesktopStatus } | { error: string }> => {
    const { id } = request.params as { id: string };
    const repoPath = projectRepoPath(id);
    if (!repoPath) {
      reply.code(404);
      return { error: 'Project not found' };
    }
    const linked = (db.prepare('SELECT claude_session_id FROM chat_threads WHERE claude_session_id IS NOT NULL').all() as Array<{ claude_session_id: string }>)
      .map((row) => row.claude_session_id);
    const sessions = await listImportableSessions(repoPath, linked, options.listSessions);
    return { sessions, desktop: status() };
  });

  fastify.post('/api/projects/:id/desktop/sessions/:sessionId/import', async (request, reply): Promise<DesktopImportResult | { kind: string; error: string }> => {
    const { id, sessionId } = request.params as { id: string; sessionId: string };
    const repoPath = projectRepoPath(id);
    if (!repoPath) {
      reply.code(404);
      return { kind: 'not_found', error: 'Project not found' };
    }
    if (!isClaudeSessionId(sessionId)) {
      reply.code(400);
      return { kind: 'bad_session', error: 'Not a Claude Code session id.' };
    }
    const existing = db.prepare('SELECT id FROM chat_threads WHERE claude_session_id = ?').get(sessionId) as { id: string } | undefined;
    if (existing) {
      reply.code(409);
      return { kind: 'already_imported', error: `That session is already on the board (thread ${existing.id}).` };
    }
    if (!transcriptExists(repoPath, sessionId)) {
      reply.code(404);
      return { kind: 'not_found', error: 'No transcript for that session under this project\'s repo path.' };
    }
    const claude = engine();
    if (!claude) {
      reply.code(409);
      return { kind: 'engine_unavailable', error: 'The Claude engine is not registered.' };
    }
    let info: SDKSessionInfo | undefined;
    try {
      info = await getSessionInfo(sessionId, { dir: repoPath });
    } catch {
      info = undefined;
    }
    const title = (info?.customTitle || info?.summary || info?.firstPrompt || '').trim().slice(0, 120) || NEW_THREAD_TITLE;
    const nowIso = now().toISOString();
    const threadId = randomUUID();
    const imported = await claude.importSdkSession(threadId, repoPath, sessionId);
    db.prepare(
      'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at, last_model_key, claude_session_id, desktop_shared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(threadId, id, title, nowIso, nowIso, null, imported.modelKey, sessionId, nowIso);
    return { thread: threadRow(threadId)!, appended: imported.appended };
  });
}
