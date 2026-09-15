import { labelledApprovals } from '../../roles/brokers.js';
/**
 * The Claude engine: sessions backed by the Claude Agent SDK, sharing the Pi
 * runtime's brokers, policy, audit sink, session directory and tool set.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { ENGINE_SESSION_CUSTOM_TYPE, type EngineSessionRecord } from '@nexus/shared';
import { openSessionManagerFor, type PiRuntime } from '../../pi/runtime.js';
import type { ChatEngine, EngineModel, EngineSession, ChildSessionOptions } from '../types.js';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, findClaudeModel } from './models.js';
import { collectPiTools } from './pi-tools-bridge.js';
import { projectContextAppendix } from './context-files.js';
import { ClaudeEngineSession, type QueryFn } from './session.js';
import { modelKeyFor } from './desktop.js';
import {
  advanceSyncCursorToEnd,
  readSyncCursor,
  replaySdkMessages,
  transcriptStat,
  writeSyncCursor,
  type GetSessionMessagesFn,
  type ReconcileResult,
} from './transcript.js';
import { getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeAuthEnv, type ClaudeEngineConfig } from './auth.js';
import { normalizeClaudeEngineConfig } from './status.js';

export interface ClaudeEngineDeps {
  pi: PiRuntime;
  /** Read fresh per call so a config edit lands without a restart. */
  config: () => ClaudeEngineConfig;
  queryFn?: QueryFn;
  /** Removes the SDK's own transcript for a dropped thread. Defaults to the SDK's `deleteSession`. */
  deleteSdkSession?: (sessionId: string, cwd: string) => Promise<void>;
  /**
   * True when the thread's transcript is shared with the Claude Desktop app
   * (handed off or imported): drop then leaves the SDK transcript alone, and
   * sessions reconcile from it around every turn. Defaults to never shared.
   */
  isTranscriptShared?: (threadId: string, cwd: string) => boolean;
  /** Injected by tests; production reads transcripts through the SDK. */
  getSessionMessages?: GetSessionMessagesFn;
  log?: (line: string) => void;
}

export interface ImportedSdkSession {
  sessionId: string;
  /** Pi messages appended to the new thread's JSONL. */
  appended: number;
  /** `claude-code/<id>` for the transcript's last assistant model (catalog fallback otherwise). */
  modelKey: string;
}

/**
 * Synchronous read of the recorded SDK session id straight from the JSONL —
 * used on drop, where the session may not be cached (backend restarted) and
 * the file is about to disappear.
 */
export function readStoredSessionIdFromFile(sessionDir: string, threadId: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((name) => name.endsWith(`_${threadId}.jsonl`));
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const name of files) {
    let text: string;
    try { text = readFileSync(join(sessionDir, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(ENGINE_SESSION_CUSTOM_TYPE)) continue;
      try {
        const entry = JSON.parse(line);
        const data = entry?.data as EngineSessionRecord | undefined;
        if (entry?.type === 'custom' && entry.customType === ENGINE_SESSION_CUSTOM_TYPE && data?.engine === 'claude-code') found = data.sessionId;
      } catch { /* skip malformed line */ }
    }
  }
  return found;
}

export class ClaudeEngine implements ChatEngine {
  readonly id = 'claude-code' as const;
  private readonly sessions = new Map<string, ClaudeEngineSession>();
  private readonly pending = new Map<string, Promise<ClaudeEngineSession>>();
  private readonly deleteSdkSession: (sessionId: string, cwd: string) => Promise<void>;

  constructor(private readonly deps: ClaudeEngineDeps) {
    this.deleteSdkSession = deps.deleteSdkSession ?? ((sessionId, cwd) => deleteSession(sessionId, { dir: cwd }));
    // Pi owns the thread's JSONL; when it drops a thread, drop our side too.
    deps.pi.onSessionDropped((threadId, cwd) => this.dropSession(threadId, cwd));
  }

  private key(threadId: string, cwd: string): string {
    return `${threadId}::${cwd}`;
  }

  listModels(): EngineModel[] {
    const configured = this.deps.config().enabled;
    return CLAUDE_CODE_MODELS.map((model) => ({ ...model, configured }));
  }

  findModel(provider: string, id: string): EngineModel | undefined {
    if (provider !== CLAUDE_CODE_PROVIDER || !this.deps.config().enabled) return undefined;
    return findClaudeModel(id);
  }

  hasSession(threadId: string, cwd: string): boolean {
    return this.sessions.has(this.key(threadId, cwd));
  }

  async sessionFor(threadId: string, cwd: string): Promise<ClaudeEngineSession> {
    const key = this.key(threadId, cwd);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const creating = this.createSession(threadId, cwd);
    this.pending.set(key, creating);
    try {
      const session = await creating;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Children bypass `sessions`, so `dropSession` never sees them: their
   * `dispose()` (called by the role runner when the run settles) removes the
   * SDK's ~/.claude transcript instead, while the child's Pi JSONL stays as the
   * retained record the role_runs ledger points at.
   */
  async createChildSession(options: ChildSessionOptions): Promise<ClaudeEngineSession> {
    return this.createSession(options.id, options.cwd, options);
  }

  private async createSession(threadId: string, cwd: string, child?: ChildSessionOptions): Promise<ClaudeEngineSession> {
    const pi = this.deps.pi;
    const sessionDir = pi.sessionDirFor(cwd);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const sessionManager = await openSessionManagerFor(threadId, cwd, sessionDir);
    const tools = await collectPiTools(pi.extensionFactoriesFor(child?.parentThreadId ?? threadId, cwd, child));
    const cfg = this.deps.config();
    const { settingSources, skills } = normalizeClaudeEngineConfig(cfg);
    const systemPromptAppendix = [
      pi.systemPromptAppendixFor(threadId, cwd),
      projectContextAppendix(cwd, pi.paths.sessionsDir, settingSources),
    ].filter(Boolean).join('\n\n');
    return new ClaudeEngineSession({
      threadId: child?.parentThreadId ?? threadId,
      role: child?.role,
      blockedByChild: child ? undefined : () => pi.roleBusy?.(threadId) ?? false,
      cwd,
      sessionManager,
      model: CLAUDE_CODE_MODELS[0],
      tools,
      systemPromptAppendix: child?.prompt ?? systemPromptAppendix,
      policy: pi.policyFor(child?.parentThreadId ?? threadId, cwd),
      approvals: child ? labelledApprovals(pi.approvals, child.role) : pi.approvals,
      audit: pi.auditSink,
      env: resolveClaudeAuthEnv(cfg),
      settingSources: child ? [] : settingSources,
      skills: child ? [] : skills === 'none' ? [] : skills,
      executablePath: cfg.executable_path?.trim() || undefined,
      queryFn: this.deps.queryFn,
      isShared: () => this.deps.isTranscriptShared?.(threadId, cwd) ?? false,
      getSessionMessages: this.deps.getSessionMessages,
      onDispose: child ? (sdkSessionId) => { if (sdkSessionId) this.removeSdkTranscript(threadId, cwd, sdkSessionId); } : undefined,
      log: this.deps.log ?? ((line) => console.log(line)),
    });
  }

  /**
   * Pull turns made in the Claude Desktop app into the thread's Pi JSONL.
   * A no-op while a Nexus turn is in flight (the session reconciles itself
   * before prompting), when the thread is not shared, or when nothing changed.
   */
  async reconcileShared(threadId: string, cwd: string): Promise<ReconcileResult | undefined> {
    if (!(this.deps.isTranscriptShared?.(threadId, cwd) ?? false)) return undefined;
    const session = await this.sessionFor(threadId, cwd);
    return session.reconcileFromDesktop();
  }

  /**
   * Seed a brand-new thread from a Claude Code session: replay the whole
   * transcript into the thread's Pi JSONL, record the SDK session id so the
   * next turn resumes it, and set the sync cursor at the end. The caller marks
   * the thread shared before any turn runs.
   */
  async importSdkSession(threadId: string, cwd: string, sessionId: string): Promise<ImportedSdkSession> {
    if (this.hasSession(threadId, cwd)) throw new Error(`Thread ${threadId} already has a live Claude session`);
    const pi = this.deps.pi;
    const sessionDir = pi.sessionDirFor(cwd);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const sessionManager = await openSessionManagerFor(threadId, cwd, sessionDir);
    if (readSyncCursor(sessionManager)) throw new Error(`Thread ${threadId} was already imported`);
    const getMessages = this.deps.getSessionMessages ?? ((id, options) => sdkGetSessionMessages(id, options));
    const messages = await getMessages(sessionId, { dir: cwd });
    const result = replaySdkMessages(sessionManager, messages, { model: CLAUDE_CODE_MODELS[0].id, log: this.deps.log });
    const record: EngineSessionRecord = { engine: 'claude-code', sessionId, recordedAt: new Date().toISOString() };
    sessionManager.appendCustomEntry(ENGINE_SESSION_CUSTOM_TYPE, record);
    const stat = transcriptStat(cwd, sessionId);
    writeSyncCursor(sessionManager, { lastUuid: result.lastUuid ?? '', messageCount: messages.length, fileSize: stat?.size ?? 0 });
    return { sessionId, appended: result.appended, modelKey: modelKeyFor(result.lastModel) };
  }

  /** After a handoff: mark everything currently in the transcript as already mirrored. */
  async markSharedFromHere(threadId: string, cwd: string, sessionId: string): Promise<void> {
    const session = await this.sessionFor(threadId, cwd);
    await advanceSyncCursorToEnd({ sessionManager: session.sessionManager, cwd, sessionId, getSessionMessages: this.deps.getSessionMessages });
  }

  dropSession(threadId: string, cwd: string): void {
    const key = this.key(threadId, cwd);
    const cached = this.sessions.get(key);
    this.sessions.delete(key);
    this.pending.delete(key);
    const sdkSessionId = cached?.engineSessionId ?? readStoredSessionIdFromFile(this.deps.pi.sessionDirFor(cwd), threadId);
    if (!sdkSessionId) return;
    // Shared with the desktop app: the transcript is its history too.
    if (this.deps.isTranscriptShared?.(threadId, cwd)) {
      this.deps.log?.(`[claude-engine ${threadId}] transcript ${sdkSessionId} is shared with Claude Desktop; left in place`);
      return;
    }
    this.removeSdkTranscript(threadId, cwd, sdkSessionId);
  }

  /** Fire-and-forget: the SDK transcript is a few KB in ~/.claude; failing to remove it must never fail a drop or a child's disposal. */
  private removeSdkTranscript(threadId: string, cwd: string, sdkSessionId: string): void {
    void this.deleteSdkSession(sdkSessionId, cwd).catch((err: any) => {
      this.deps.log?.(`[claude-engine ${threadId}] could not delete SDK session ${sdkSessionId}: ${err?.message ?? err}`);
    });
  }
}
