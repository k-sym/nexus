/**
 * Maps Claude Agent SDK messages onto Pi's session-event vocabulary and
 * Pi-shaped transcript messages. Pure: every side effect goes through the
 * sinks, so the mapping is testable with fixtures.
 *
 * Streaming: the SDK's `stream_event` messages (`includePartialMessages`) give
 * the deltas; the `assistant` messages are authoritative and are what gets
 * persisted. While a response streams the CLI emits *one `assistant` message
 * per completed content block* — consecutive frames share `message.id`, each
 * carries only its own block, `stop_reason` is null and `usage` is not final —
 * so frames are buffered per `message.id` and flushed once as a single Pi
 * message (see `flushAssistant`). Tool results arrive as `user` messages
 * carrying `tool_result` blocks. Subagent traffic (`parent_tool_use_id` set)
 * is ignored — only the main thread is rendered, as Pi has no subagents either.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsage } from '@earendil-works/pi-coding-agent';
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { EngineSessionEvent } from '../types.js';
import { toDisplayToolName } from './tool-names.js';

export interface MapperSinks {
  provider: string;
  model: string;
  emit(event: EngineSessionEvent): void;
  persist(message: AssistantMessage | ToolResultMessage): void;
  /** Structured details a bridged Nexus tool produced for this tool call (Task 8 side channel). */
  detailsFor(toolCallId: string): unknown;
  onSessionId(sessionId: string, apiKeySource: string): void;
  onContextUsage(usage: ContextUsage): void;
  now?: () => number;
}

type AssistantBlock = TextContent | ThinkingContent | ToolCall;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } };
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use': return 'toolUse';
    case 'max_tokens': return 'length';
    case 'refusal': return 'error';
    default: return 'stop';
  }
}

function mapUsage(usage: any): Usage {
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const cacheRead = Number(usage?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? 0);
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { ...ZERO_COST } };
}

function mapBlocks(content: any[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const block of content ?? []) {
    if (block?.type === 'text') blocks.push({ type: 'text', text: block.text ?? '' });
    else if (block?.type === 'thinking') blocks.push({ type: 'thinking', thinking: block.thinking ?? '', ...(block.signature ? { thinkingSignature: block.signature } : {}) });
    else if (block?.type === 'redacted_thinking') blocks.push({ type: 'thinking', thinking: '', redacted: true } as ThinkingContent);
    else if (block?.type === 'tool_use') blocks.push({ type: 'toolCall', id: block.id, name: toDisplayToolName(block.name), arguments: block.input ?? {} });
    // server_tool_use / web_search results etc. have no Pi equivalent and are dropped.
  }
  return blocks;
}

/**
 * True when `incoming` is the same block as `existing`, re-sent by a frame that
 * repeats accumulated content — identical, or grown by more streamed text. A
 * repeat can only ever extend a block, never rewrite it, so anything else is a
 * genuinely new block that happens to share a type.
 */
function repeatsBlock(existing: AssistantBlock, incoming: AssistantBlock): boolean {
  if (existing.type !== incoming.type) return false;
  if (existing.type === 'text' && incoming.type === 'text') return incoming.text.startsWith(existing.text);
  if (existing.type === 'thinking' && incoming.type === 'thinking') return incoming.thinking.startsWith(existing.thinking);
  return false;
}

/**
 * Merge one frame's blocks into the buffer. Frames normally carry exactly one
 * new block, so the default is to append. A producer that repeats the full
 * accumulated content instead is tolerated:
 *   - a tool call whose id is already buffered *anywhere* is dropped (ids are
 *     unique per response, and a repeat must not add a second copy or a second
 *     `tool_execution_start`);
 *   - a text/thinking block that repeats the one already at the same position
 *     replaces it, so the longer version wins.
 * Two adjacent blocks of one type are still kept apart, because a new block
 * does not extend the previous one.
 */
function mergeBlocks(buffered: AssistantBlock[], incoming: AssistantBlock[]): AssistantBlock[] {
  const merged = buffered.slice();
  incoming.forEach((block, index) => {
    if (block.type === 'toolCall') {
      if (!merged.some((held) => held.type === 'toolCall' && held.id === block.id)) merged.push(block);
      return;
    }
    const existing = merged[index];
    if (existing && repeatsBlock(existing, block)) {
      merged[index] = block;
      return;
    }
    merged.push(block);
  });
  return merged;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' ? b.text ?? '' : '')).join('');
}

/** One response's `assistant` frames, buffered until the turn moves on. */
interface PendingAssistant {
  /** `message.id`; frames of one response share it. */
  id: string | undefined;
  blocks: AssistantBlock[];
  usage: Usage;
  /** Raw SDK stop reason; null until a frame carries one. */
  stopReason: string | null;
  model: string | undefined;
  timestamp: number;
  /** A streamed partial already emitted `message_start` for this response. */
  streamed: boolean;
  error?: unknown;
  errorText?: string;
  contextUsage?: any;
}

/** One instance per `query()`: it holds that turn's streaming and buffering state. */
export class SdkEventMapper {
  private partial: AssistantMessage | null = null;
  private pendingAssistant: PendingAssistant | null = null;
  private readonly jsonBuffers = new Map<number, string>();
  private readonly toolNames = new Map<string, string>();
  private retrying: number | null = null;
  private compacting = false;
  private lastAssistantErrored = false;
  private aborted = false;
  private resultError: string | undefined;
  private resultOk = true;

  constructor(private readonly sinks: MapperSinks) {}

  private now(): number {
    return this.sinks.now?.() ?? Date.now();
  }

  private newAssistant(model?: string): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: this.sinks.provider,
      model: model || this.sinks.model,
      usage: zeroUsage(),
      stopReason: 'pending',
      timestamp: this.now(),
    };
  }

  handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg as any);
        return;
      case 'stream_event':
        if ((msg as any).parent_tool_use_id) return;
        this.endRetry();
        this.handleStreamEvent((msg as any).event);
        return;
      case 'assistant':
        if ((msg as any).parent_tool_use_id) return;
        this.endRetry();
        this.handleAssistant(msg as any);
        return;
      case 'user':
        if ((msg as any).parent_tool_use_id) return;
        // The turn moved on: close the buffered response before its results.
        this.flushAssistant();
        this.handleUser(msg as any);
        return;
      case 'result':
        this.flushAssistant();
        this.handleResult(msg as any);
        return;
      default:
        return;
    }
  }

  /** The turn was aborted: close any half-streamed message as `aborted`. Not an error — no `errorMessage`. */
  abort(): void {
    this.aborted = true;
    // The streamed partial holds everything the buffered frames do (the SDK is
    // always run with `includePartialMessages`), so the buffer is dropped
    // rather than flushed — flushing it would double-report the same content.
    this.pendingAssistant = null;
    if (!this.partial) return;
    const message: AssistantMessage = { ...this.partial, content: this.partial.content.filter(Boolean), stopReason: 'aborted' };
    this.sinks.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'error', reason: 'aborted', error: message } });
    this.sinks.emit({ type: 'message_end', message });
    this.sinks.persist(message);
    this.partial = null;
    this.jsonBuffers.clear();
  }

  /** The query itself failed (process died, auth error thrown): show it like a provider error. */
  fail(message: string): void {
    this.resultOk = false;
    this.resultError = message;
    this.pendingAssistant = null;
    if (!this.partial && this.lastAssistantErrored) return;
    if (this.partial) {
      const partial = this.partial;
      const errored: AssistantMessage = { ...partial, content: partial.content.filter(Boolean), stopReason: 'error', errorMessage: message };
      this.sinks.emit({ type: 'message_update', message: errored, assistantMessageEvent: { type: 'error', reason: 'error', error: errored } });
      this.sinks.emit({ type: 'message_end', message: errored });
      this.sinks.persist(errored);
      this.lastAssistantErrored = true;
      this.partial = null;
      this.jsonBuffers.clear();
      return;
    }
    this.emitErrorMessage(message);
  }

  /**
   * Stop was pressed. The SDK answers `interrupt()` with a terminating `result`
   * (`error_during_execution`) that arrives while the loop is still draining;
   * marking the abort here keeps `handleResult` from turning it into a spurious
   * error bubble. Nothing else changes — `abort()` still closes the partial.
   */
  markAborting(): void {
    this.aborted = true;
  }

  finish(): { ok: boolean; error?: string } {
    return this.resultOk ? { ok: true } : { ok: false, error: this.resultError };
  }

  private handleSystem(msg: any): void {
    switch (msg.subtype) {
      case 'init':
        this.sinks.onSessionId(msg.session_id, String(msg.apiKeySource ?? 'unknown'));
        return;
      case 'status':
        if (msg.status === 'compacting' && !this.compacting) {
          this.compacting = true;
          this.sinks.emit({ type: 'compaction_start', reason: 'threshold' });
        } else if (msg.status !== 'compacting' && this.compacting) {
          this.endCompaction('threshold', msg.compact_result === 'failed' ? msg.compact_error ?? 'Compaction failed' : undefined);
        }
        return;
      case 'compact_boundary':
        if (this.compacting) this.endCompaction(msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'threshold');
        return;
      case 'api_retry': {
        const status = msg.error_status ? ` (HTTP ${msg.error_status})` : '';
        this.retrying = msg.attempt;
        this.sinks.emit({
          type: 'auto_retry_start',
          attempt: msg.attempt,
          maxAttempts: msg.max_retries,
          delayMs: msg.retry_delay_ms,
          errorMessage: `${msg.error}${status}`,
        });
        return;
      }
      default:
        return;
    }
  }

  private endCompaction(reason: 'manual' | 'threshold', errorMessage?: string): void {
    this.compacting = false;
    this.sinks.emit({
      type: 'compaction_end',
      reason,
      result: undefined,
      aborted: false,
      willRetry: false,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  private endRetry(): void {
    if (this.retrying === null) return;
    this.sinks.emit({ type: 'auto_retry_end', success: true, attempt: this.retrying });
    this.retrying = null;
  }

  private ensurePartial(model?: string): AssistantMessage {
    if (!this.partial) {
      this.partial = this.newAssistant(model);
      this.sinks.emit({ type: 'message_start', message: this.partial });
      this.sinks.emit({ type: 'message_update', message: this.partial, assistantMessageEvent: { type: 'start', partial: this.partial } });
    }
    return this.partial;
  }

  private update(event: any): void {
    const partial = this.partial!;
    this.sinks.emit({ type: 'message_update', message: partial, assistantMessageEvent: { ...event, partial } });
  }

  private handleStreamEvent(event: any): void {
    switch (event?.type) {
      case 'message_start':
        // A new response starts: whatever frames are still buffered belong to
        // the previous one.
        this.flushAssistant();
        this.partial = null;
        this.ensurePartial(event.message?.model);
        return;
      case 'content_block_start': {
        const partial = this.ensurePartial();
        const index: number = event.index;
        const block = event.content_block;
        if (block?.type === 'text') {
          partial.content[index] = { type: 'text', text: '' };
          this.update({ type: 'text_start', contentIndex: index });
        } else if (block?.type === 'thinking') {
          partial.content[index] = { type: 'thinking', thinking: '' };
          this.update({ type: 'thinking_start', contentIndex: index });
        } else if (block?.type === 'redacted_thinking') {
          partial.content[index] = { type: 'thinking', thinking: '', redacted: true };
          this.update({ type: 'thinking_start', contentIndex: index });
        } else if (block?.type === 'tool_use') {
          const name = toDisplayToolName(block.name);
          partial.content[index] = { type: 'toolCall', id: block.id, name, arguments: {} };
          this.jsonBuffers.set(index, '');
          this.toolNames.set(block.id, name);
          this.update({ type: 'toolcall_start', contentIndex: index });
        }
        return;
      }
      case 'content_block_delta': {
        const partial = this.ensurePartial();
        const index: number = event.index;
        const current = partial.content[index];
        const delta = event.delta;
        if (!current || !delta) return;
        if (delta.type === 'text_delta' && current.type === 'text') {
          current.text += delta.text ?? '';
          this.update({ type: 'text_delta', contentIndex: index, delta: delta.text ?? '' });
        } else if (delta.type === 'thinking_delta' && current.type === 'thinking') {
          current.thinking += delta.thinking ?? '';
          this.update({ type: 'thinking_delta', contentIndex: index, delta: delta.thinking ?? '' });
        } else if (delta.type === 'signature_delta' && current.type === 'thinking') {
          current.thinkingSignature = delta.signature;
        } else if (delta.type === 'input_json_delta' && current.type === 'toolCall') {
          this.jsonBuffers.set(index, (this.jsonBuffers.get(index) ?? '') + (delta.partial_json ?? ''));
          this.update({ type: 'toolcall_delta', contentIndex: index, delta: delta.partial_json ?? '' });
        }
        return;
      }
      case 'content_block_stop': {
        const partial = this.ensurePartial();
        const index: number = event.index;
        const current = partial.content[index];
        if (!current) return;
        if (current.type === 'text') this.update({ type: 'text_end', contentIndex: index, content: current.text });
        else if (current.type === 'thinking') this.update({ type: 'thinking_end', contentIndex: index, content: current.thinking });
        else if (current.type === 'toolCall') {
          const raw = this.jsonBuffers.get(index) ?? '';
          try { current.arguments = raw ? JSON.parse(raw) : {}; } catch { current.arguments = {}; }
          this.update({ type: 'toolcall_end', contentIndex: index, toolCall: current });
        }
        return;
      }
      case 'message_delta': {
        const partial = this.ensurePartial();
        if (event.delta?.stop_reason) partial.stopReason = mapStopReason(event.delta.stop_reason);
        if (event.usage?.output_tokens !== undefined) partial.usage.output = Number(event.usage.output_tokens);
        return;
      }
      default:
        return;
    }
  }

  private handleAssistant(msg: any): void {
    const beta = msg.message ?? {};
    const id: string | undefined = beta.id;
    if (this.pendingAssistant && this.pendingAssistant.id !== id) this.flushAssistant();
    if (!this.pendingAssistant) {
      this.pendingAssistant = {
        id,
        blocks: [],
        usage: zeroUsage(),
        stopReason: null,
        model: beta.model,
        timestamp: this.partial?.timestamp ?? this.now(),
        streamed: this.partial !== null,
      };
    }
    const pending = this.pendingAssistant;
    pending.blocks = mergeBlocks(pending.blocks, mapBlocks(beta.content));
    if (beta.model) pending.model = beta.model;
    if (beta.usage) pending.usage = mapUsage(beta.usage);
    if (beta.stop_reason != null) pending.stopReason = beta.stop_reason;
    if (msg.error) {
      pending.error = msg.error;
      pending.errorText = extractText(beta.content);
    }
    if (msg.context_usage) pending.contextUsage = msg.context_usage;
    // A frame that carries a stop reason ends the response; otherwise the
    // buffer waits for the next flush trigger (a `user`/`result` frame, a new
    // response's `message_start`, or a frame with a different `message.id`).
    if (pending.stopReason !== null) this.flushAssistant();
  }

  /**
   * Close the buffered response: one merged Pi message, announced once,
   * persisted once, with `tool_execution_start` for each of its tool calls.
   */
  private flushAssistant(): void {
    const pending = this.pendingAssistant;
    if (!pending) return;
    this.pendingAssistant = null;
    // A `message_delta` stop reason is the fallback when no frame carried one.
    const streamedStopReason = this.partial && this.partial.stopReason !== 'pending' ? this.partial.stopReason : undefined;
    const message: AssistantMessage = {
      ...this.newAssistant(pending.model),
      timestamp: pending.timestamp,
      content: pending.blocks,
      usage: pending.usage,
      stopReason: pending.stopReason !== null ? mapStopReason(pending.stopReason) : streamedStopReason ?? 'stop',
      ...(pending.id ? { responseId: pending.id } : {}),
    };
    if (pending.error !== undefined) {
      message.stopReason = 'error';
      message.errorMessage = pending.errorText ? `${pending.error}: ${pending.errorText}` : String(pending.error);
    } else if (pending.stopReason === 'refusal') {
      message.errorMessage = 'The model declined this request (refusal).';
    }
    // Stop was pressed while these frames were buffered: what arrived is a
    // truncated turn, not an error — close it the way `abort()` closes a
    // streamed partial.
    const aborted = this.aborted;
    if (aborted) {
      message.stopReason = 'aborted';
      delete message.errorMessage;
    }
    if (!pending.streamed) {
      this.sinks.emit({ type: 'message_start', message });
      this.sinks.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'start', partial: message } });
    }
    const isError = !aborted && message.stopReason === 'error';
    this.sinks.emit({
      type: 'message_update',
      message,
      assistantMessageEvent: aborted
        ? { type: 'error', reason: 'aborted', error: message }
        : isError
          ? { type: 'error', reason: 'error', error: message }
          : { type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message },
    });
    this.sinks.emit({ type: 'message_end', message });
    this.sinks.persist(message);
    // An aborted turn never ran its tool calls, so it announces none.
    for (const block of aborted ? [] : message.content) {
      if (block.type !== 'toolCall') continue;
      this.toolNames.set(block.id, block.name);
      this.sinks.emit({ type: 'tool_execution_start', toolCallId: block.id, toolName: block.name, args: block.arguments });
    }
    if (pending.contextUsage) {
      const cu = pending.contextUsage;
      this.sinks.onContextUsage({ tokens: cu.total_tokens, contextWindow: cu.raw_max_tokens, percent: cu.percentage } as ContextUsage);
    }
    this.lastAssistantErrored = isError;
    this.partial = null;
    this.jsonBuffers.clear();
  }

  private handleUser(msg: any): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return; // our own prompt echoed back
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolCallId: string = block.tool_use_id;
      const toolName = this.toolNames.get(toolCallId) ?? 'tool';
      const details = this.sinks.detailsFor(toolCallId);
      const isError = block.is_error === true;
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text: extractText(block.content) }],
        ...(details !== undefined ? { details } : {}),
        isError,
        timestamp: this.now(),
      };
      this.sinks.emit({
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: { content: result.content, ...(details !== undefined ? { details } : {}) },
        isError,
      });
      this.sinks.persist(result);
    }
  }

  private handleResult(msg: any): void {
    if (this.retrying !== null) {
      const success = msg.subtype === 'success';
      this.sinks.emit({
        type: 'auto_retry_end',
        success,
        attempt: this.retrying,
        ...(success ? {} : { finalError: msg.subtype }),
      });
      this.retrying = null;
    }
    if (this.compacting) this.endCompaction('threshold', 'Turn ended during compaction');
    const failed = msg.is_error === true || msg.subtype !== 'success';
    if (!failed) return;
    this.resultOk = false;
    this.resultError = msg.subtype;
    if (this.aborted || this.lastAssistantErrored) return; // already reported (aborted, or the assistant message told the story)
    const detail = typeof msg.result === 'string' && msg.result.trim() ? `: ${msg.result.trim()}` : '';
    this.emitErrorMessage(`${msg.subtype}${detail}`);
  }

  private emitErrorMessage(errorMessage: string): void {
    const message: AssistantMessage = { ...this.newAssistant(), stopReason: 'error', errorMessage };
    this.sinks.emit({ type: 'message_start', message });
    this.sinks.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'error', reason: 'error', error: message } });
    this.sinks.emit({ type: 'message_end', message });
    this.sinks.persist(message);
    this.lastAssistantErrored = true;
  }
}
