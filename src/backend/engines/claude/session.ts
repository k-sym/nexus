/**
 * A chat session backed by the Claude Agent SDK. One `query()` per turn,
 * resumed through the SDK session id recorded in the thread's JSONL.
 *
 * Everything the chat route relies on from a Pi session is here: Pi-shaped
 * events to subscribers, Pi-shaped entries in `sessionManager` (so
 * `flattenEntries`, archive and run markers work unchanged), abort that
 * resolves `prompt()` rather than rejecting it, and context usage after the
 * turn. Tool calls go through `decideToolCall` — the same gate, broker, policy
 * and audit rows as Pi sessions.
 */
import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentSessionEventListener, ContextUsage, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ImageContent, UserMessage } from '@earendil-works/pi-ai';
import { ENGINE_SESSION_CUSTOM_TYPE, type EngineSessionRecord } from '@nexus/shared';
import { decideToolCall, type ApprovalBroker } from '../../pi/approvals.js';
import type { ToolPolicyResolver } from '../../pi/tool-policy.js';
import type { ThinkingLevel } from '../../pi/thinking.js';
import type { ApprovalAudit } from '../../approvals/audit.js';
import type { EngineModel, EngineSession, EngineSessionEvent } from '../types.js';
import { CLAUDE_CODE_PROVIDER, toSdkThinking } from './models.js';
import { NEXUS_MCP_SERVER, toPolicyToolName } from './tool-names.js';
import { ToolUseCorrelator } from './tool-use-correlator.js';
import { createNexusMcpServer, type PiToolDefinition } from './pi-tools-bridge.js';
import { SdkEventMapper } from './events.js';

export type QueryFn = typeof sdkQuery;

/** How long a graceful `interrupt()` gets before the child process is killed. */
const INTERRUPT_GRACE_MS = 2_000;

export interface ClaudeSessionDeps {
  threadId: string;
  cwd: string;
  sessionManager: SessionManager;
  model: EngineModel;
  tools: PiToolDefinition[];
  systemPromptAppendix: string;
  policy: ToolPolicyResolver;
  approvals: ApprovalBroker;
  audit: ApprovalAudit;
  env: Record<string, string | undefined>;
  executablePath?: string;
  /** Injected by tests; production uses the SDK's `query`. */
  queryFn?: QueryFn;
  log?: (line: string) => void;
}

/** The last recorded SDK session id for this thread, or undefined for a fresh thread. */
export function readStoredSessionId(sessionManager: Pick<SessionManager, 'getEntries'>): string | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as any;
    if (entry?.type !== 'custom' || entry.customType !== ENGINE_SESSION_CUSTOM_TYPE) continue;
    const data = entry.data as EngineSessionRecord | undefined;
    if (data?.engine === 'claude-code' && typeof data.sessionId === 'string') return data.sessionId;
  }
  return undefined;
}

async function* single(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield message;
}

function buildPrompt(text: string, images: ImageContent[]): string | AsyncIterable<SDKUserMessage> {
  if (images.length === 0) return text;
  return single({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: image.data },
        })),
      ],
    },
  });
}

export class ClaudeEngineSession implements EngineSession {
  readonly sessionManager: SessionManager;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly queryFn: QueryFn;
  private model: EngineModel;
  private thinkingLevel: ThinkingLevel | undefined;
  private sdkSessionId: string | undefined;
  private active: { controller: AbortController; query: Query; aborting: boolean } | null = null;
  private lastContextUsage: ContextUsage | undefined;
  private readonly detailsByToolCall = new Map<string, unknown>();
  private loggedAuthSource = false;

  constructor(private readonly deps: ClaudeSessionDeps) {
    this.sessionManager = deps.sessionManager;
    this.model = deps.model;
    this.queryFn = deps.queryFn ?? sdkQuery;
    this.sdkSessionId = readStoredSessionId(deps.sessionManager);
  }

  get engineSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async setModel(model: EngineModel): Promise<void> {
    this.model = model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
  }

  supportsThinking(): boolean {
    return this.model.reasoning === true;
  }

  getContextUsage(): ContextUsage | undefined {
    return this.lastContextUsage;
  }

  async abort(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.aborting = true;
    try {
      await active.query.interrupt();
    } catch {
      /* the process may already be gone */
    }
    const kill = setTimeout(() => {
      if (this.active === active) active.controller.abort();
    }, INTERRUPT_GRACE_MS);
    kill.unref?.();
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.active) throw new Error('A turn is already in progress for this session');
    const images = options?.images ?? [];
    this.persistUserMessage(text, images);

    const controller = new AbortController();
    const correlator = new ToolUseCorrelator();
    const mapper = new SdkEventMapper({
      provider: CLAUDE_CODE_PROVIDER,
      model: this.model.id,
      emit: (event) => this.emit(event),
      persist: (message) => { this.sessionManager.appendMessage(message as any); },
      detailsFor: (toolCallId) => this.detailsByToolCall.get(toolCallId),
      onSessionId: (sessionId, source) => this.recordSessionId(sessionId, source),
      onContextUsage: (usage) => { this.lastContextUsage = usage; },
    });
    const mcp = createNexusMcpServer(this.deps.tools, {
      cwd: this.deps.cwd,
      correlator,
      signal: () => controller.signal,
      onUpdate: (toolCallId, toolName, partial) => this.emit({ type: 'tool_execution_update', toolCallId, toolName, args: {}, partialResult: partial }),
      onDetails: (toolCallId, details) => { this.detailsByToolCall.set(toolCallId, details); },
    });
    const rememberToolUse: HookCallback = async (input) => {
      if (input.hook_event_name === 'PreToolUse') correlator.remember(input.tool_name, input.tool_use_id, input.tool_input);
      return {};
    };
    const appendix = this.deps.systemPromptAppendix;
    const queryOptions: Options = {
      cwd: this.deps.cwd,
      model: this.model.id,
      ...toSdkThinking(this.model, this.thinkingLevel),
      ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
      includePartialMessages: true,
      permissionMode: 'default',
      // No ~/.claude or project settings: Nexus's tool policy is the only permission source.
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(appendix ? { append: appendix } : {}) },
      // Nexus's `question` tool (via MCP) replaces Claude's built-in so the existing question UI/broker/iOS flow works.
      disallowedTools: ['AskUserQuestion'],
      mcpServers: { [NEXUS_MCP_SERVER]: mcp },
      canUseTool: this.gate(controller.signal),
      hooks: { PreToolUse: [{ hooks: [rememberToolUse] }] },
      abortController: controller,
      env: this.deps.env,
      ...(this.deps.executablePath ? { pathToClaudeCodeExecutable: this.deps.executablePath } : {}),
      stderr: (data) => this.deps.log?.(`[claude-engine ${this.deps.threadId}] ${data.trimEnd()}`),
    };

    const q = this.queryFn({ prompt: buildPrompt(text, images), options: queryOptions });
    const active = { controller, query: q, aborting: false };
    this.active = active;
    try {
      for await (const message of q) mapper.handle(message);
      if (active.aborting) mapper.abort();
    } catch (err: any) {
      if (active.aborting || controller.signal.aborted || err?.name === 'AbortError') {
        mapper.abort();
      } else {
        const reason = err?.message || 'Claude engine failed';
        this.deps.log?.(`[claude-engine ${this.deps.threadId}] query failed: ${reason}`);
        mapper.fail(reason);
      }
    } finally {
      this.active = null;
      correlator.clear();
      this.detailsByToolCall.clear();
    }
  }

  private gate(turnSignal: AbortSignal): CanUseTool {
    return async (toolName, input, opts) => {
      const decision = await decideToolCall({
        threadId: this.deps.threadId,
        cwd: this.deps.cwd,
        toolName: toPolicyToolName(toolName),
        toolCallId: opts.toolUseID,
        input,
        signal: opts.signal ?? turnSignal,
        broker: this.deps.approvals,
        policy: this.deps.policy,
        audit: this.deps.audit,
      });
      return decision.block
        ? { behavior: 'deny', message: decision.reason ?? 'Denied' }
        : { behavior: 'allow', updatedInput: input };
    };
  }

  private emit(event: EngineSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch {
        /* a misbehaving subscriber must not break the turn */
      }
    }
  }

  private persistUserMessage(text: string, images: ImageContent[]): void {
    const message: UserMessage = {
      role: 'user',
      content: images.length > 0 ? [{ type: 'text', text }, ...images] : text,
      timestamp: Date.now(),
    };
    this.sessionManager.appendMessage(message as any);
  }

  private recordSessionId(sessionId: string, source: string): void {
    if (!this.loggedAuthSource) {
      this.loggedAuthSource = true;
      this.deps.log?.(`[claude-engine ${this.deps.threadId}] auth source: ${source}`);
    }
    if (sessionId === this.sdkSessionId) return;
    this.sdkSessionId = sessionId;
    const record: EngineSessionRecord = { engine: 'claude-code', sessionId, recordedAt: new Date().toISOString() };
    this.sessionManager.appendCustomEntry(ENGINE_SESSION_CUSTOM_TYPE, record);
  }
}
