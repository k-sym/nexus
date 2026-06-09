/**
 * Pi runtime — the bridge between Fastify and @earendil-works/pi-coding-agent.
 *
 * One PiRuntime per backend process. Owns the AuthStorage and ModelRegistry;
 * per-thread AgentSession instances are created on demand and cached by
 * `threadId::cwd`. Sessions are independent — the SDK is not a "many
 * sessions" runtime; AgentSessionRuntime wraps a single session and we use
 * createAgentSession() per chat thread instead.
 */
import { mkdirSync } from 'node:fs';
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

/** Encode a repo path as a directory-safe slug for per-cwd session dirs. */
export function cwdSlug(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
}

export class PiRuntime {
  readonly auth: AuthStorage;
  readonly models: ModelRegistry;
  private readonly paths: PiRuntimePaths;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionPromises = new Map<string, Promise<AgentSession>>();

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

  /** Drop a session (e.g. on thread delete). */
  dropSession(threadId: string, cwd: string): void {
    this.sessions.delete(`${threadId}::${cwd}`);
    this.sessionPromises.delete(`${threadId}::${cwd}`);
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
}
