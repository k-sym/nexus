/**
 * The Claude engine: sessions backed by the Claude Agent SDK, sharing the Pi
 * runtime's brokers, policy, audit sink, session directory and tool set.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { ENGINE_SESSION_CUSTOM_TYPE, type EngineSessionRecord } from '@nexus/shared';
import { openSessionManagerFor, type PiRuntime } from '../../pi/runtime.js';
import type { ChatEngine, EngineModel, EngineSession } from '../types.js';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, findClaudeModel } from './models.js';
import { collectPiTools } from './pi-tools-bridge.js';
import { projectContextAppendix } from './context-files.js';
import { ClaudeEngineSession, type QueryFn } from './session.js';
import { resolveClaudeAuthEnv, type ClaudeEngineConfig } from './auth.js';
import { normalizeClaudeEngineConfig } from './status.js';

export interface ClaudeEngineDeps {
  pi: PiRuntime;
  /** Read fresh per call so a config edit lands without a restart. */
  config: () => ClaudeEngineConfig;
  queryFn?: QueryFn;
  /** Removes the SDK's own transcript for a dropped thread. Defaults to the SDK's `deleteSession`. */
  deleteSdkSession?: (sessionId: string, cwd: string) => Promise<void>;
  log?: (line: string) => void;
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

  async sessionFor(threadId: string, cwd: string): Promise<EngineSession> {
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

  private async createSession(threadId: string, cwd: string): Promise<ClaudeEngineSession> {
    const pi = this.deps.pi;
    const sessionDir = pi.sessionDirFor(cwd);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const sessionManager = await openSessionManagerFor(threadId, cwd, sessionDir);
    const tools = await collectPiTools(pi.extensionFactoriesFor(threadId, cwd));
    const cfg = this.deps.config();
    const { settingSources, skills } = normalizeClaudeEngineConfig(cfg);
    const systemPromptAppendix = [
      pi.systemPromptAppendixFor(threadId, cwd),
      projectContextAppendix(cwd, pi.paths.sessionsDir, settingSources),
    ].filter(Boolean).join('\n\n');
    return new ClaudeEngineSession({
      threadId,
      cwd,
      sessionManager,
      model: CLAUDE_CODE_MODELS[0],
      tools,
      systemPromptAppendix,
      policy: pi.policyFor(threadId, cwd),
      approvals: pi.approvals,
      audit: pi.auditSink,
      env: resolveClaudeAuthEnv(cfg),
      settingSources,
      skills: skills === 'none' ? [] : skills,
      executablePath: cfg.executable_path?.trim() || undefined,
      queryFn: this.deps.queryFn,
      log: this.deps.log ?? ((line) => console.log(line)),
    });
  }

  dropSession(threadId: string, cwd: string): void {
    const key = this.key(threadId, cwd);
    const cached = this.sessions.get(key);
    this.sessions.delete(key);
    this.pending.delete(key);
    const sdkSessionId = cached?.engineSessionId ?? readStoredSessionIdFromFile(this.deps.pi.sessionDirFor(cwd), threadId);
    if (!sdkSessionId) return;
    // Fire-and-forget: the SDK transcript is a few KB in ~/.claude; failing to
    // remove it must never fail the drop.
    void this.deleteSdkSession(sdkSessionId, cwd).catch((err: any) => {
      this.deps.log?.(`[claude-engine ${threadId}] could not delete SDK session ${sdkSessionId}: ${err?.message ?? err}`);
    });
  }
}
