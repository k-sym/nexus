/**
 * Pi runtime — the bridge between Fastify and @earendil-works/pi-coding-agent.
 *
 * One PiRuntime per backend process. Owns the ModelRuntime and ModelRegistry;
 * per-thread AgentSession instances are created on demand and cached by
 * `threadId::cwd`. Sessions are independent — the SDK is not a "many
 * sessions" runtime; AgentSessionRuntime wraps a single session and we use
 * createAgentSession() per chat thread instead.
 */
import { mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSession, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { AGENT_RUN_CUSTOM_TYPE } from '@nexus/shared';
import {
  ModelRegistry,
  ModelRuntime,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import anthropicMessagesBridge from '@blackbelt-technology/pi-anthropic-messages';
import { QuestionBroker, createQuestionExtension } from './questions.js';
import { ApprovalBroker, createApprovalExtension } from './approvals.js';
import { createSignalFilterExtension } from '../signal-filters/extension.js';
import { createMemoryExtension, type MemoryRecallFn } from './memory-tool.js';
import { createToolPolicyResolver, type ToolPolicyResolver } from './tool-policy.js';
import { createDockerExtension, type DockerToolDeps } from './docker-tool.js';
import { buildOrientationBlock, modelKeyHasVision } from './orientation.js';
import { createBrowserExtension, type BrowserToolDeps } from './browser-tool.js';
import { createMondayExtension, type MondayToolDeps } from './monday-tool.js';
import { buildMondayContextBlock, type MondayContextInput } from './monday-context.js';
import { defaultLocalModelsFile } from './local-models.js';
import { getNexusDir } from '../config.js';

type ResourceLoaderOptions = {
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
  noExtensions?: boolean;
  extensionFactories?: ExtensionFactory[];
  /** Re-evaluated on every session create AND resume (unlike the transcript),
   *  so a thread reopened later sees current state rather than a stale line
   *  frozen in message history. Matches pi's DefaultResourceLoaderOptions
   *  shape exactly (verified against resource-loader.d.ts). */
  systemPromptOverride?: (base: string | undefined) => string | undefined;
};

type SessionInfoLike = {
  id: string;
  path: string;
  modified: Date;
};

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
  input?: Array<'text' | 'image'>;
}

export interface PiRuntimePaths {
  /** Path to the auth.json file. Default: ~/.nexus/auth.json */
  authFile: string;
  /** Root directory for session JSONL files. Default: ~/.nexus/sessions */
  sessionsDir: string;
  /** Path to Nexus-managed Pi custom models. Default: ~/.nexus/models.json */
  modelsFile?: string;
}

/** Everything the runtime needs from the rest of the backend. Each entry is
 *  optional and its absence means "omit that capability" — tests and headless
 *  callers construct a runtime with none of them. */
export interface PiRuntimeDeps {
  recallMemories?: MemoryRecallFn;
  mondayContext?: (threadId: string, cwd: string) => MondayContextInput | null;
  mondayTools?: (threadId: string) => MondayToolDeps | null;
  dockerTools?: (threadId: string, cwd: string) => DockerToolDeps | null;
  browserTools?: (threadId: string, cwd: string) => BrowserToolDeps | null;
  /** Fire-and-forget teardown of a thread's compose project on session drop. */
  tearDownServices?: (threadId: string, cwd: string) => void;
  /** Fire-and-forget close of a thread's browser on session drop. */
  closeBrowser?: (threadId: string) => void;
  /** This thread's persisted model key (`provider/id`), for the orientation
   *  block's vision line. Read from the DB so it survives a restart, unlike the
   *  in-memory session model. Undefined resolver ⇒ vision is never asserted. */
  sessionModelKey?: (threadId: string, cwd: string) => string | undefined;
}

export const defaultPiRuntimePaths = (): Required<PiRuntimePaths> => ({
  authFile: join(getNexusDir(), 'auth.json'),
  sessionsDir: join(getNexusDir(), 'sessions'),
  modelsFile: defaultLocalModelsFile(),
});

/** Encode a repo path as a directory-safe slug for per-cwd session dirs.
 *  Absolute paths strip their leading slash so the dir tree doesn't
 *  have a leading underscore for every project. */
export function cwdSlug(repoPath: string): string {
  if (!repoPath) return 'default';
  const cleaned = repoPath.startsWith('/') || repoPath.startsWith('\\') ? repoPath.slice(1) : repoPath;
  return cleaned.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
}

export function buildResourceLoaderOptions(
  options: Pick<ResourceLoaderOptions, 'cwd' | 'agentDir' | 'settingsManager' | 'extensionFactories' | 'systemPromptOverride'>,
): ResourceLoaderOptions {
  return {
    ...options,
    noExtensions: true,
    extensionFactories: [anthropicMessagesBridge, ...(options.extensionFactories ?? [])],
  };
}

export function buildSessionExtensionFactories(
  threadId: string,
  cwd: string,
  questions: QuestionBroker,
  approvals: ApprovalBroker,
  policy: ToolPolicyResolver,
  signalFactoryBuilder: (cwd: string) => ExtensionFactory = createSignalFilterExtension,
  recallMemories?: MemoryRecallFn,
  mondayTools?: (threadId: string) => MondayToolDeps | null,
  dockerTools?: (threadId: string, cwd: string) => DockerToolDeps | null,
  browserTools?: (threadId: string, cwd: string) => BrowserToolDeps | null,
): ExtensionFactory[] {
  // Mirrors the mondayContext guard in createSession below. Unlike that call,
  // this one has no try/catch at its call site (it's part of the
  // extensionFactories: buildSessionExtensionFactories(...) argument to an
  // object literal, not a statement that could wrap it) — so the guard has
  // to live here. buildMondayToolDeps() already guards its own body, but
  // this must not depend on that: a throw here today means an unopenable,
  // permanently broken thread (MINOR 6).
  let monday: MondayToolDeps | null = null;
  try {
    monday = mondayTools?.(threadId) ?? null;
  } catch {
    monday = null;
  }
  // Same guard, same reason: a resolver that throws must cost the thread its
  // Docker tool, not its ability to open at all.
  let docker: DockerToolDeps | null = null;
  try {
    docker = dockerTools?.(threadId, cwd) ?? null;
  } catch {
    docker = null;
  }
  let browser: BrowserToolDeps | null = null;
  try {
    browser = browserTools?.(threadId, cwd) ?? null;
  } catch {
    browser = null;
  }
  return [
    createQuestionExtension(threadId, questions),
    createApprovalExtension(threadId, cwd, approvals, policy),
    signalFactoryBuilder(cwd),
    // Omitted when the runtime was built without a recall backend (tests,
    // headless callers) so sessions don't advertise a tool that can't run.
    ...(recallMemories ? [createMemoryExtension(cwd, recallMemories)] : []),
    // Same contract for Monday: omitted wholesale when the feature is off,
    // unconfigured, or this thread's task has no linked item.
    ...(monday ? [createMondayExtension(monday)] : []),
    // And for Docker: omitted when the feature is off or no daemon answered
    // the probe, so a session never offers to start containers it can't.
    ...(docker ? [createDockerExtension(docker)] : []),
    // And for the browser: omitted when the feature is off or the machine has
    // no Chromium-family browser to drive.
    ...(browser ? [createBrowserExtension(browser)] : []),
  ];
}

function mostRecentlyModifiedSessionForThread<T extends SessionInfoLike>(
  infos: T[],
  threadId: string,
): T | undefined {
  return infos
    .filter((info) => info.id === threadId)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())[0];
}

export class PiRuntime {
  readonly auth: ModelRuntime;
  readonly models: ModelRegistry;
  /** Internal path config. Exposed read-only for the orchestrator's headless sessions. */
  readonly paths: Required<PiRuntimePaths>;
  readonly questions = new QuestionBroker();
  /** Tool-permission "Supervise" gate. Pending tool calls for supervised chat
   *  sessions park here until the user allows/denies from the glasses. */
  readonly approvals = new ApprovalBroker();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionPromises = new Map<string, Promise<AgentSession>>();
  private readonly sessionModels = new Map<string, string>();
  /** Thread ids with Supervise enabled. Per-session, in-memory, off by default
   *  (so a restart never leaves a session silently gating). Toggled by the
   *  gateway `POST /api/supervise`; read live at each tool call. */
  private readonly supervised = new Set<string>();
  /** Backend for the `memory_recall` tool. Undefined = the tool isn't registered. */
  private readonly recallMemories?: MemoryRecallFn;
  /** Resolves the linked-item snapshot for a thread's system prompt, or null
   *  when the thread's task has no linked item (or the feature is off).
   *  Undefined = no resolver supplied, e.g. tests and other headless callers. */
  private readonly mondayContext?: (threadId: string, cwd: string) => MondayContextInput | null;
  /** Resolves the Monday tool deps for a thread, or null to omit the tools
   *  entirely. Same "omit when absent" contract as recallMemories. */
  private readonly mondayTools?: (threadId: string) => MondayToolDeps | null;
  /** Resolves the Docker tool deps for a thread, or null to omit the tool.
   *  Same contract again. */
  private readonly dockerTools?: (threadId: string, cwd: string) => DockerToolDeps | null;
  /** Tears down a thread's compose project. Called on session drop so services
   *  a thread started don't outlive it. Undefined = nothing to tear down. */
  private readonly tearDownServices?: (threadId: string, cwd: string) => void;
  /** Resolves the browser tool deps for a thread, or null to omit them. */
  private readonly browserTools?: (threadId: string, cwd: string) => BrowserToolDeps | null;
  /** Closes a thread's browser on session drop. */
  private readonly closeBrowser?: (threadId: string) => void;
  /** Resolves a thread's persisted model key, for the orientation vision line. */
  private readonly sessionModelKey?: (threadId: string, cwd: string) => string | undefined;

  private constructor(
    paths: Required<PiRuntimePaths>,
    modelRuntime: ModelRuntime,
    // A deps object rather than more positional params: `create()` already
    // takes one, and this list only grows as tools are added.
    deps: PiRuntimeDeps,
  ) {
    this.paths = paths;
    this.auth = modelRuntime;
    this.models = new ModelRegistry(modelRuntime);
    this.recallMemories = deps.recallMemories;
    this.mondayContext = deps.mondayContext;
    this.mondayTools = deps.mondayTools;
    this.dockerTools = deps.dockerTools;
    this.tearDownServices = deps.tearDownServices;
    this.browserTools = deps.browserTools;
    this.closeBrowser = deps.closeBrowser;
    this.sessionModelKey = deps.sessionModelKey;
  }

  /** Whether this session would get the Docker tool — used to decide if the
   *  orientation block mentions running services. Guarded: a throwing resolver
   *  costs the mention, not the session. */
  private hasDockerFor(threadId: string, cwd: string): boolean {
    try { return (this.dockerTools?.(threadId, cwd) ?? null) != null; } catch { return false; }
  }

  /** Whether this session would get the browser tools. */
  private hasBrowserFor(threadId: string, cwd: string): boolean {
    try { return (this.browserTools?.(threadId, cwd) ?? null) != null; } catch { return false; }
  }

  /** Whether this thread's model can see images — so the orientation block can
   *  mention screenshots only when they're useful. Prefers the persisted model
   *  key (survives a restart) over the in-memory one. */
  private hasVisionFor(threadId: string, cwd: string): boolean {
    try {
      const key = this.sessionModelKey?.(threadId, cwd) ?? this.getSessionModel(threadId, cwd);
      return modelKeyHasVision(key, (provider, id) => this.findModel(provider, id));
    } catch {
      return false;
    }
  }

  static async create(
    paths: Partial<PiRuntimePaths> = defaultPiRuntimePaths(),
    deps: PiRuntimeDeps = {},
  ): Promise<PiRuntime> {
    const defaults = defaultPiRuntimePaths();
    const resolvedPaths = {
      authFile: paths.authFile ?? defaults.authFile,
      sessionsDir: paths.sessionsDir ?? defaults.sessionsDir,
      modelsFile: paths.modelsFile ?? defaults.modelsFile,
    };
    mkdirSync(join(resolvedPaths.authFile, '..'), { recursive: true });
    mkdirSync(resolvedPaths.sessionsDir, { recursive: true });
    const modelRuntime = await ModelRuntime.create({
      authPath: resolvedPaths.authFile,
      modelsPath: resolvedPaths.modelsFile,
      allowModelNetwork: false,
    });
    return new PiRuntime(resolvedPaths, modelRuntime, deps);
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

  /** Enable or disable Supervise (the tool-permission gate) for a chat thread. */
  setSupervised(threadId: string, on: boolean): void {
    if (on) this.supervised.add(threadId);
    else {
      this.supervised.delete(threadId);
      // Release any gates already parked for this thread so a mid-run "stop
      // supervising" doesn't strand a tool call. Denied (default-safe) — the
      // tool won't run, but the session is no longer wedged.
      this.approvals.cancelThread(threadId, 'Supervise disabled');
    }
  }

  /** Whether Supervise is enabled for a chat thread. */
  isSupervised(threadId: string): boolean {
    return this.supervised.has(threadId);
  }

  /** Thread ids currently supervised (for gateway state reporting). */
  listSupervised(): string[] {
    return Array.from(this.supervised);
  }

  /**
   * The tool policy for a thread. Built once per session, but every input it
   * reads is a getter evaluated at tool-call time — so toggling Supervise (or,
   * later, editing project policy) lands on the next tool call without
   * rebuilding the session. That liveness is load-bearing; do not resolve
   * these into values here.
   */
  policyFor(threadId: string): ToolPolicyResolver {
    return createToolPolicyResolver({ isSupervised: () => this.isSupervised(threadId) });
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
    const sessionDir = this.sessionDirFor(cwd);
    // Resume an existing on-disk session for this thread if one exists.
    // SessionManager.create(cwd, dir, { id }) always starts a BLANK session —
    // the { id } option only names a brand-new file; it never reopens an
    // existing one. So after a backend restart (or any in-memory cache
    // eviction), naively calling create() here would spawn a second, empty
    // `<timestamp>_<threadId>.jsonl` and the model would lose all prior
    // conversation context. We look up the thread's existing file (the same
    // lookup readMessages() uses) and open() the most recently modified match
    // to continue the conversation. Only when no prior session exists do we
    // create a new one.
    let sessionManager;
    try {
      const infos = await SessionManager.list(cwd, sessionDir);
      const existing = mostRecentlyModifiedSessionForThread(infos, threadId);
      sessionManager = existing
        ? SessionManager.open(existing.path, sessionDir, cwd)
        : SessionManager.create(cwd, sessionDir, { id: threadId });
    } catch {
      // Listing failed (e.g. corrupt/locked session dir) — fall back to a
      // fresh session rather than blocking the turn entirely.
      sessionManager = SessionManager.create(cwd, sessionDir, { id: threadId });
    }
    const settingsManager = SettingsManager.inMemory();
    // Resolving Monday context must never be able to fail session creation.
    // resourceLoader.reload() below is awaited with no guard, so a throw from
    // this.mondayContext (e.g. a real DB-backed resolver hitting a bad row)
    // would reject createSession entirely, bricking the thread until the
    // underlying data is fixed by hand. Degrade to "no Monday context"
    // instead — a session without its Monday block is a small loss; a
    // session that cannot open at all is a serious one.
    let resolvedMondayContext: MondayContextInput | null = null;
    try {
      resolvedMondayContext = this.mondayContext?.(threadId, cwd) ?? null;
    } catch {
      resolvedMondayContext = null;
    }
    // Bind to a const so the ternary/closure below narrows to non-null
    // permanently, rather than re-checking a mutable `let` at closure-call
    // time.
    const mondayContext = resolvedMondayContext;
    const resourceLoader = new DefaultResourceLoader(buildResourceLoaderOptions({
      cwd,
      agentDir: this.paths.sessionsDir,
      settingsManager,
      extensionFactories: buildSessionExtensionFactories(
        threadId, cwd, this.questions, this.approvals, this.policyFor(threadId),
        createSignalFilterExtension, this.recallMemories, this.mondayTools, this.dockerTools,
        this.browserTools,
      ),
      // Re-evaluated on every session create AND resume, so a thread reopened
      // later reflects the capabilities and item state it has THEN, not a line
      // frozen at first creation. Two blocks are appended: the Nexus orientation
      // (always) and the Monday context (when the task has a linked item). Each
      // is guarded independently — a block that throws is skipped, and the base
      // prompt always comes through, rather than a bad block failing the whole
      // session.
      systemPromptOverride: (base: string | undefined) => {
        const parts: string[] = [];
        if (base) parts.push(base);
        try {
          parts.push(buildOrientationBlock({
            hasMemory: !!this.recallMemories,
            hasDocker: this.hasDockerFor(threadId, cwd),
            hasBrowser: this.hasBrowserFor(threadId, cwd),
            hasVision: this.hasVisionFor(threadId, cwd),
          }));
        } catch { /* orientation is a nicety; never fail a session over it */ }
        if (mondayContext) {
          try {
            parts.push(buildMondayContextBlock(mondayContext));
          } catch { /* skip the Monday block, keep the rest */ }
        }
        return parts.join('\n\n');
      },
    }) as ConstructorParameters<typeof DefaultResourceLoader>[0]);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: this.auth,
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
    this.supervised.delete(threadId);
    this.questions.cancelThread(threadId, 'Session dropped');
    this.approvals.cancelThread(threadId, 'Session dropped');
    // Containers a thread started must not outlive it. This is the whole
    // reason the compose project name is derived from the thread id rather
    // than recorded somewhere: teardown needs no surviving state, so it works
    // even for a thread whose session was never held in memory. Guarded and
    // fire-and-forget — dropping a thread must not fail because Docker is
    // down, and anything left behind is still reachable by a later sweep.
    try {
      this.tearDownServices?.(threadId, cwd);
    } catch { /* best effort */ }
    // Same contract for the browser: a session's browser process must not
    // outlive it, and failing to close one must not fail the drop.
    try {
      this.closeBrowser?.(threadId);
    } catch { /* best effort */ }
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
      input: (m as any).input,
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
    const match = mostRecentlyModifiedSessionForThread(infos, threadId);
    if (!match) return [];
    const sm = SessionManager.open(match.path, sessionDir, cwd);
    return sm.getEntries().filter((entry) =>
      entry.type === 'message'
      || (entry.type === 'custom' && entry.customType === AGENT_RUN_CUSTOM_TYPE),
    );
  }
}
