/**
 * Pi runtime — the bridge between Fastify and @earendil-works/pi-coding-agent.
 *
 * One PiRuntime per backend process. Owns the AuthStorage and ModelRegistry;
 * per-thread AgentSession instances are created on demand and cached by
 * `threadId::cwd`. Sessions are independent — the SDK is not a "many
 * sessions" runtime; AgentSessionRuntime wraps a single session and we use
 * createAgentSession() per chat thread instead.
 */
import { mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';

/**
 * A minimal model shape we expose from the runtime. Matches the fields we
 * forward to the frontend. The full `Model<Api>` from `@earendil-works/pi-ai`
 * has many more fields; consumers that need them can call
 * `runtime.models.find(...)` directly.
 */
export interface ModelShape {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiRuntimePaths {
  /** Path to the auth.json file. Default: ~/.nexus/auth.json */
  authFile: string;
  /** Root directory for session JSONL files. Default: ~/.nexus/sessions */
  sessionsDir: string;
}

export const defaultPiRuntimePaths = (): PiRuntimePaths => ({
  authFile: join(homedir(), '.nexus', 'auth.json'),
  sessionsDir: join(homedir(), '.nexus', 'sessions'),
});

/** Encode a repo path as a directory-safe slug for per-cwd session dirs.
 *  Absolute paths strip their leading slash so the dir tree doesn't
 *  have a leading underscore for every project. */
export function cwdSlug(repoPath: string): string {
  if (!repoPath) return 'default';
  const cleaned = repoPath.startsWith('/') || repoPath.startsWith('\\') ? repoPath.slice(1) : repoPath;
  return cleaned.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
}

export class PiRuntime {
  readonly auth: AuthStorage;
  readonly models: ModelRegistry;
  /** Internal path config. Exposed read-only for the orchestrator's headless sessions. */
  readonly paths: PiRuntimePaths;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionPromises = new Map<string, Promise<AgentSession>>();
  private readonly sessionModels = new Map<string, string>();

  constructor(paths: PiRuntimePaths = defaultPiRuntimePaths()) {
    this.paths = paths;
    mkdirSync(join(paths.authFile, '..'), { recursive: true });
    mkdirSync(paths.sessionsDir, { recursive: true });
    this.auth = AuthStorage.create(paths.authFile);
    this.models = ModelRegistry.create(this.auth);
  }

  /**
   * Session directory for a given cwd. One directory per project so sessions
   * are organized the way pi does by default, but rooted at ~/.nexus/sessions.
   */
  sessionDirFor(cwd: string): string {
    return join(this.paths.sessionsDir, cwdSlug(cwd));
  }

  /**
   * Check if a session already exists for the given thread and cwd.
   */
  hasSession(threadId: string, cwd: string): boolean {
    return this.sessions.has(`${threadId}::${cwd}`);
  }

  /**
   * Get the model key currently set for a session.
   */
  getSessionModel(threadId: string, cwd: string): string | undefined {
    return this.sessionModels.get(`${threadId}::${cwd}`);
  }

  /**
   * Record the model key set for a session.
   */
  setSessionModel(threadId: string, cwd: string, modelKey: string): void {
    this.sessionModels.set(`${threadId}::${cwd}`, modelKey);
  }

  /**
   * Get or create a session for a thread bound to a cwd.
   *
   * The session is created with `SessionManager.create(cwd, sessionDir, { id: threadId })`
   * so the file on disk is named after the thread id, and a second call with
   * the same (threadId, cwd) returns the same AgentSession instance.
   */
  async sessionFor(threadId: string, cwd: string): Promise<AgentSession> {
    const key = `${threadId}::${cwd}`;
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const pending = this.sessionPromises.get(key);
    if (pending) return pending;
    const promise = this.createSession(threadId, cwd);
    this.sessionPromises.set(key, promise);
    try {
      const session = await promise;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.sessionPromises.delete(key);
    }
  }

  private async createSession(threadId: string, cwd: string): Promise<AgentSession> {
    // Dynamic import so the ESM-only pi package is loaded at call time
    // (avoids top-level CJS resolution failures in tsx when the workspace
    // doesn't set type:module).
    const { SessionManager, SettingsManager, DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
    const sessionManager = SessionManager.create(cwd, this.sessionDirFor(cwd), { id: threadId });
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.paths.sessionsDir,
      settingsManager,
      noExtensions: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      authStorage: this.auth,
      modelRegistry: this.models,
      sessionManager,
      settingsManager,
      resourceLoader,
    });
    return session;
  }

  /**
   * Drop a session (e.g. on thread delete). Removes the in-memory cache
   * AND the on-disk session file(s). Pi names files
   * `${fileTimestamp}_${sessionId}.jsonl`, so we look for any file
   * ending in `_${threadId}.jsonl` in the session dir. Best-effort —
   * missing files are fine (an empty session was never flushed).
   */
  dropSession(threadId: string, cwd: string): void {
    const key = `${threadId}::${cwd}`;
    this.sessions.delete(key);
    this.sessionPromises.delete(key);
    this.sessionModels.delete(key);
    const sessionDir = this.sessionDirFor(cwd);
    try {
      for (const name of readdirSync(sessionDir)) {
        if (name.endsWith(`_${threadId}.jsonl`)) {
          try { unlinkSync(join(sessionDir, name)); } catch { /* already gone */ }
        }
      }
    } catch { /* dir doesn't exist = nothing to drop */ }
  }

  /** Find a model by `provider/id` shape. Returns undefined if not available. */
  findModel(provider: string, modelId: string): ModelShape | undefined {
    const m = this.models.find(provider, modelId);
    if (!m) return undefined;
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    };
  }

  /**
   * List session metadata for a cwd, in last-modified-first order.
   * Returns the pi SessionInfo shape: { id, name, path, messageCount, ... }.
   */
  async listSessions(cwd: string): Promise<unknown[]> {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sessionDir = this.sessionDirFor(cwd);
    const infos = await SessionManager.list(cwd, sessionDir);
    return infos;
  }

  /**
   * Read the messages of a thread's session from disk. The session is opened
   * read-only — no in-memory session is created in the runtime, so this is
   * safe to call for threads that haven't been prompted yet (returns []).
   */
  async readMessages(threadId: string, cwd: string): Promise<unknown[]> {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sessionDir = this.sessionDirFor(cwd);
    const infos = await SessionManager.list(cwd, sessionDir);
    const match = infos.find((s) => s.id === threadId);
    if (!match) return [];
    const sm = SessionManager.open(match.path, sessionDir, cwd);
    return sm.getEntries().filter((e) => e.type === 'message');
  }
}
