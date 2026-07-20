/**
 * usePiStream — frontend hook that subscribes to a chat turn's event
 * stream (NDJSON over HTTP), folds the events into a renderable
 * `state`, and supports a 409 + X-Confirm-Cancel conflict path.
 *
 * The reducer handles Pi's streaming events: thinking deltas, text
 * deltas, tool calls, and message completion. The transport is a
 * regular fetch + ReadableStream consumer.
 */
import { useCallback, useReducer, useRef } from 'react';
import { apiFetch } from '../api-base';
import {
  agentRunReducer,
  type AgentRunAction,
  type AgentRunView,
} from '../chat/agent-run-state';
import { agentRunActionsFor } from '../chat/agent-run-events';

/** Granular tool execution phase for richer status display. */
export type ToolPhase =
  | { type: 'calling'; toolName: string; args: Record<string, unknown> }
  | { type: 'executing'; toolName: string; partialOutput: string }
  | { type: 'done'; toolName: string }
  | { type: 'error'; toolName: string; message: string };

export type ChatImageAttachment = {
  type: 'image';
  data: string;
  mimeType: string;
  name?: string;
  size?: number;
};

export type ChatFileAttachment = {
  type: 'file';
  data: string;
  mimeType: string;
  name: string;
  size?: number;
  path?: string;
};

export type ChatAttachment = ChatImageAttachment | ChatFileAttachment;

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SignalFilterTelemetry {
  input_bytes: number;
  output_bytes: number;
  saved_bytes: number;
  saved_percent: number;
  applied_filters: string[];
}

export interface StreamMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  attachments?: ChatAttachment[];
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: 'running' | 'completed' | 'error' | 'interrupted';
    result?: string;
    details?: unknown;
    is_error?: boolean;
  }>;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp: number;
  isStreaming?: boolean;
  signal_filter?: SignalFilterTelemetry;
  run?: AgentRunView;
  /** Live-only marker: the next prose delta starts after tool activity. */
  pendingTextBreak?: boolean;
}

export interface StreamState {
  messages: StreamMessage[];
  streamingMessage: StreamMessage | null;
  isRunning: boolean;
  status: 'idle' | 'thinking' | 'tool_call' | 'responding' | 'error';
  error: string | null;
  contextUsage: ContextUsage | null;
  activeRun: AgentRunView | null;
}

export type StreamAction =
  | { type: 'START_STREAM'; prompt: string; attachments?: ChatAttachment[] }
  | { type: 'TEXT_DELTA'; delta: string }
  | { type: 'THINKING_DELTA'; delta: string }
  | { type: 'TOOL_CALL_START'; toolCall: { id: string; name: string; args: Record<string, unknown> } }
  | { type: 'TOOL_CALL_UPDATE'; id: string; patch: Record<string, unknown> }
  | { type: 'TOOL_PARTIAL_OUTPUT'; id: string; partialOutput: string }
  | { type: 'MESSAGE_END'; message?: Partial<StreamMessage> }
  | { type: 'CONTEXT_USAGE'; usage: ContextUsage | null }
  | { type: 'STREAM_COMPLETE' }
  | { type: 'STREAM_ERROR'; error: string }
  | { type: 'ABORT_STREAM'; source?: 'user' | 'frontend' }
  | { type: 'RUN_ACTION'; action: AgentRunAction }
  | { type: 'RESET'; contextUsage?: ContextUsage | null };

export const INITIAL_STATE: StreamState = {
  messages: [],
  streamingMessage: null,
  isRunning: false,
  status: 'idle',
  error: null,
  contextUsage: null,
  activeRun: null,
};

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function makeId(): string {
  let out = '';
  for (let i = 0; i < 12; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

function extractMessageSnapshot(message: any): Partial<StreamMessage> | undefined {
  if (!message || message.role !== 'assistant') return undefined;
  let content = '';
  let thinking = '';
  let toolSinceLastText = false;
  const toolCalls: StreamMessage['toolCalls'] = [];
  for (const block of message.content ?? []) {
    if (block?.type === 'text') {
      const text = block.text ?? '';
      if (toolSinceLastText && content.trim() && text && !content.endsWith('\n') && !text.startsWith('\n')) {
        content += '\n\n';
      }
      content += text;
      toolSinceLastText = false;
    }
    else if (block?.type === 'thinking') thinking += block.thinking ?? '';
    else if (block?.type === 'toolCall') {
      toolSinceLastText = true;
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.arguments ?? {},
        status: 'running',
      });
    }
  }
  return {
    content,
    thinking,
    toolCalls,
    timestamp: message.timestamp,
  };
}

function formatProviderError(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) return '';
  const trimmed = message.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      const providerMessage = parsed?.error?.message ?? parsed?.message;
      if (typeof providerMessage === 'string' && providerMessage.trim()) return providerMessage;
    } catch {
      /* fall through */
    }
  }
  return trimmed;
}

/**
 * True for a dropped/failed network transport (as opposed to an HTTP error
 * response the server actually sent). WebKit surfaces these as `TypeError:
 * Load failed`, Chromium as `TypeError: Failed to fetch`, Firefox as a
 * NetworkError. We match by name AND message because the concrete error type
 * can differ across the packaged webview, so `instanceof TypeError` alone is
 * unreliable. AbortError is a deliberate cancel, not a transport failure.
 */
function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === 'AbortError') return false;
  if (err instanceof TypeError || err.name === 'TypeError') return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('network error') ||
    msg.includes('networkerror')
  );
}

function extractThinkingEventContent(event: any): string {
  if (typeof event?.delta === 'string') return event.delta;
  if (typeof event?.content === 'string') return event.content;
  const content = event?.partial?.content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'thinking')
      .map((block) => block.thinking ?? '')
      .join('');
  }
  return '';
}

function normalizeContextUsage(value: any): ContextUsage | null {
  if (!value || typeof value !== 'object') return null;
  const contextWindow = Number(value.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const tokens = value.tokens === null ? null : Number(value.tokens);
  const percent = value.percent === null ? null : Number(value.percent);
  return {
    tokens: Number.isFinite(tokens) ? tokens : null,
    contextWindow,
    percent: Number.isFinite(percent) ? percent : null,
  };
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'START_STREAM':
      return {
        ...INITIAL_STATE,
        isRunning: true,
        status: 'thinking',
        messages: [
          {
            id: makeId(),
            role: 'user',
            content: action.prompt,
            attachments: action.attachments,
            timestamp: Date.now(),
          },
        ],
        streamingMessage: {
          id: makeId(),
          role: 'assistant',
          content: '',
          thinking: '',
          toolCalls: [],
          timestamp: Date.now(),
          isStreaming: true,
        },
      };

    case 'TEXT_DELTA': {
      const m = state.streamingMessage;
      if (!m) return state;
      const separator = m.pendingTextBreak && m.content.trim() && action.delta &&
        !m.content.endsWith('\n') && !action.delta.startsWith('\n') ? '\n\n' : '';
      return {
        ...state,
        streamingMessage: {
          ...m,
          content: m.content + separator + action.delta,
          pendingTextBreak: false,
        },
        status: 'responding',
      };
    }

    case 'THINKING_DELTA': {
      const m = state.streamingMessage;
      if (!m) return state;
      return {
        ...state,
        streamingMessage: { ...m, thinking: (m.thinking ?? '') + action.delta },
        status: 'thinking',
      };
    }

    case 'TOOL_CALL_START': {
      const m = state.streamingMessage;
      if (!m) return state;
      const existing = m.toolCalls ?? [];
      if (existing.some((tc) => tc.id === action.toolCall.id)) return state;
      return {
        ...state,
        streamingMessage: {
          ...m,
          toolCalls: [...existing, { ...action.toolCall, status: 'running' }],
          pendingTextBreak: m.pendingTextBreak || !!m.content.trim(),
        },
        status: 'tool_call',
      };
    }

    case 'TOOL_CALL_UPDATE': {
      const m = state.streamingMessage;
      if (!m?.toolCalls) return state;
      return {
        ...state,
        streamingMessage: {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === action.id ? { ...tc, ...action.patch } : tc,
          ),
        },
      };
    }

    case 'TOOL_PARTIAL_OUTPUT': {
      const m = state.streamingMessage;
      if (!m?.toolCalls) return state;
      return {
        ...state,
        streamingMessage: {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === action.id
              ? { ...tc, result: (tc.result ?? '') + action.partialOutput }
              : tc,
          ),
        },
      };
    }

    case 'MESSAGE_END': {
      if (!action.message) return state;
      const current = state.streamingMessage;
      if (!current) return state;
      return {
        ...state,
        streamingMessage: {
          ...current,
          content: action.message.content ?? current.content,
          thinking: action.message.thinking ?? current.thinking,
          toolCalls: action.message.toolCalls
            ? [
                ...action.message.toolCalls.map((snapshot) => {
                  const live = current.toolCalls?.find((toolCall) => toolCall.id === snapshot.id);
                  return live ? { ...snapshot, ...live } : snapshot;
                }),
                ...(current.toolCalls ?? []).filter(
                  (live) => !action.message?.toolCalls?.some((snapshot) => snapshot.id === live.id),
                ),
              ]
            : current.toolCalls,
          timestamp: action.message.timestamp ?? current.timestamp,
          pendingTextBreak: false,
        },
      };
    }

    case 'CONTEXT_USAGE':
      return { ...state, contextUsage: action.usage };

    case 'RUN_ACTION': {
      const activeRun = agentRunReducer(state.activeRun, action.action);
      return {
        ...state,
        activeRun,
        streamingMessage: state.streamingMessage && activeRun
          ? { ...state.streamingMessage, run: activeRun }
          : state.streamingMessage,
      };
    }

    case 'STREAM_COMPLETE': {
      const m = state.streamingMessage;
      if (!m) {
        return { ...state, isRunning: false, status: 'idle', streamingMessage: null };
      }
      const hasRun = !!(state.activeRun ?? m.run);
      const isEmpty = !m.content && !m.thinking && (!m.toolCalls || m.toolCalls.length === 0) && !hasRun;
      if (isEmpty) {
        return { ...state, isRunning: false, status: 'idle', streamingMessage: null };
      }
      return {
        ...state,
        isRunning: false,
        status: 'idle',
        messages: [...state.messages, { ...m, run: state.activeRun ?? m.run, isStreaming: false }],
        streamingMessage: null,
      };
    }

    case 'STREAM_ERROR':
      return { ...state, isRunning: false, status: 'error', error: action.error };

    case 'ABORT_STREAM': {
      const current = state.streamingMessage;
      const at = Date.now();
      const activeRun = state.activeRun
        ? agentRunReducer(state.activeRun, {
            type: 'RUN_ENDED',
            run: {
              runId: state.activeRun.runId,
              threadId: state.activeRun.threadId,
              completedAt: new Date(at).toISOString(),
              status: 'cancelled',
              abortSource: action.source ?? 'frontend',
            },
          })
        : null;
      const hasContent = current && (
        current.content ||
        current.thinking ||
        (current.toolCalls && current.toolCalls.length > 0) ||
        current.run ||
        activeRun
      );
      if (hasContent) {
        return {
          ...state,
          isRunning: false,
          status: 'idle',
          activeRun,
          messages: [...state.messages, { ...current, run: activeRun ?? current.run, isStreaming: false }],
          streamingMessage: null,
        };
      }
      return { ...state, activeRun, isRunning: false, status: 'idle' };
    }

    case 'RESET':
      return { ...INITIAL_STATE, contextUsage: action.contextUsage ?? null };

    default:
      return state;
  }
}

export class ChatBusyError extends Error {
  constructor(
    public readonly activeThreadId: string,
    public readonly activeTitle: string,
    public readonly modelKey?: string,
  ) {
    super(`Thread ${activeThreadId} is busy`);
    this.name = 'ChatBusyError';
  }
}

export function usePiStream() {
  const [state, dispatch] = useReducer(streamReducer, INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const activeThreadRef = useRef<string | null>(null);
  const streamingThreadRef = useRef<string | null>(null);
  // Outcome of the most recent startStream call. 'disconnected' means the
  // transport dropped mid-run (the backend run may still be alive); callers use
  // this to decide whether to adopt persisted history or keep the optimistic
  // turn until the re-attach poller reconciles it.
  const lastOutcomeRef = useRef<'completed' | 'disconnected' | 'error'>('completed');

  const setActiveThread = useCallback((threadId: string | null) => {
    activeThreadRef.current = threadId;
  }, []);

  const routeEvent = useCallback((ev: any, threadId: string, onError?: (message: string) => void): ContextUsage | null => {
    // Only dispatch events if they belong to the active thread
    if (activeThreadRef.current !== threadId) {
      return null;
    }
    
    const type = ev?.type;
    const now = Date.now();
    for (const action of agentRunActionsFor(ev, now)) {
      dispatch({ type: 'RUN_ACTION', action });
    }
    if (ev?.kind === 'run_start') {
      return null;
    }
    if (ev?.kind === 'run_end') {
      dispatch({ type: 'STREAM_COMPLETE' });
      return null;
    }
    if (type === 'context_usage') {
      const usage = normalizeContextUsage(ev.usage);
      dispatch({ type: 'CONTEXT_USAGE', usage });
      return usage;
    }
    if (type === 'message_start') {
      // start a fresh assistant sub-bubble; reducer is single-bubble for now
      return null;
    }
    if (type === 'message_update') {
      const ame = ev.assistantMessageEvent;
      if (!ame) return null;
      if (ame.type === 'thinking_delta') {
        dispatch({ type: 'THINKING_DELTA', delta: ame.delta });
      }
      else if (ame.type === 'thinking_end') {
        const thinking = extractThinkingEventContent(ame);
        if (thinking) dispatch({ type: 'MESSAGE_END', message: { thinking } });
      }
      else if (ame.type === 'text_delta') {
        dispatch({ type: 'TEXT_DELTA', delta: ame.delta });
      }
      else if (ame.type === 'toolcall_end') {
        dispatch({ type: 'TOOL_CALL_START', toolCall: { id: ame.toolCall.id, name: ame.toolCall.name, args: ame.toolCall.arguments ?? {} } });
      } else if (ame.type === 'error') {
        const reason =
          ame.message ??
          ame.error?.message ??
          (typeof ame.error === 'string' ? ame.error : undefined) ??
          (ame.reason === 'aborted' ? 'Aborted' : ame.reason ?? 'Error');
        dispatch({ type: 'STREAM_ERROR', error: reason });
        onError?.(reason);
      }
    } else if (type === 'message_end') {
      if (ev.message?.role === 'assistant' && (ev.message.stopReason === 'error' || ev.message.errorMessage)) {
        const error = formatProviderError(ev.message.errorMessage) || 'Provider returned an error.';
        dispatch({ type: 'STREAM_ERROR', error });
        onError?.(error);
        return null;
      }
      dispatch({ type: 'MESSAGE_END', message: extractMessageSnapshot(ev.message) });
    } else if (type === 'tool_execution_start') {
      dispatch({
        type: 'TOOL_CALL_START',
        toolCall: { id: ev.toolCallId, name: ev.toolName, args: ev.args ?? {} },
      });
    } else if (type === 'tool_execution_update') {
      const partial = (ev.partialResult?.content ?? [])
        .map((c: { text?: string }) => c.text ?? '')
        .join('');
      dispatch({ type: 'TOOL_CALL_UPDATE', id: ev.toolCallId, patch: { status: 'running' } });
      dispatch({ type: 'TOOL_PARTIAL_OUTPUT', id: ev.toolCallId, partialOutput: partial });
    } else if (type === 'tool_execution_end') {
      const result = (ev.result?.content ?? [])
        .map((c: { text?: string }) => c.text ?? '')
        .join('');
      dispatch({
        type: 'TOOL_CALL_UPDATE',
        id: ev.toolCallId,
        patch: {
          status: ev.isError ? 'error' : 'completed',
          result,
          details: ev.result?.details,
          is_error: ev.isError,
        },
      });
    } else if (type === 'done') {
      dispatch({ type: 'STREAM_COMPLETE' });
    } else if (type === 'error') {
      const error = ev.message ?? 'Unknown error';
      dispatch({ type: 'STREAM_ERROR', error });
      onError?.(error);
    }
    return null;
  }, []);

  const startStream = useCallback(
    async (
      threadId: string,
      text: string,
      opts: { confirmCancel?: boolean; modelKey?: string; attachments?: ChatAttachment[]; images?: ChatImageAttachment[]; onError?: (message: string) => void; onTitle?: (title: string) => void } = {},
    ): Promise<ContextUsage | null> => {
      activeThreadRef.current = threadId;
      streamingThreadRef.current = threadId;
      const attachments = opts.attachments ?? opts.images ?? [];
      dispatch({ type: 'START_STREAM', prompt: text, attachments });
      lastOutcomeRef.current = 'completed';
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const clearRequestRefs = () => {
        if (abortRef.current === ctrl) abortRef.current = null;
        if (streamingThreadRef.current === threadId) streamingThreadRef.current = null;
      };
      const images = attachments.filter((attachment): attachment is ChatImageAttachment => attachment.type === 'image');
      const files = attachments.filter((attachment) => attachment.type === 'file');
      const requestBody = {
        content: text,
        modelKey: opts.modelKey,
        ...(files.length > 0 ? { attachments } : images.length > 0 ? { images } : {}),
      };
      let res: Response;
      try {
        res = await apiFetch(`/api/threads/${threadId}/messages/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.confirmCancel ? { 'X-Confirm-Cancel': 'true' } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: ctrl.signal,
        });
      } catch (err) {
        clearRequestRefs();
        if ((err as Error).name === 'AbortError') {
          lastOutcomeRef.current = 'disconnected';
          return null;
        }
        if (isTransportError(err)) {
          // The initial connection dropped (packaged WebKit surfaces this as
          // "Load failed" on the first cold-start turn). The request may still
          // have reached the backend, which keeps the run alive — the re-attach
          // poller reconciles it. Degrade softly instead of flashing a hard
          // error on every cold-start first turn. (Genuine backend-unreachable
          // is rare here: the app only opens after the backend health-poll.)
          lastOutcomeRef.current = 'disconnected';
          dispatch({ type: 'STREAM_COMPLETE' });
          return null;
        }
        dispatch({ type: 'STREAM_ERROR', error: (err as Error).message });
        opts.onError?.((err as Error).message);
        return null;
      }
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body.kind === 'model_busy') {
          clearRequestRefs();
          throw new ChatBusyError(
            body.activeThreadId ?? '',
            body.activeTitle ?? 'busy thread',
            body.modelKey,
          );
        }
        const error = body.error ?? body.message ?? `HTTP ${res.status}`;
        dispatch({ type: 'STREAM_ERROR', error });
        opts.onError?.(error);
        clearRequestRefs();
        return null;
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        const error = body.error ?? body.message ?? `HTTP ${res.status}`;
        dispatch({ type: 'STREAM_ERROR', error });
        opts.onError?.(error);
        clearRequestRefs();
        return null;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let lastContextUsage: ContextUsage | null = null;
      let sawRunStart = false;
      let sawRunEnd = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let parsed: any;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (parsed?.kind === 'run_start') sawRunStart = true;
            if (parsed?.kind === 'run_end') {
              sawRunEnd = true;
              routeEvent(parsed, threadId, opts.onError);
              return lastContextUsage;
            }
            // The backend named a session from its opening prompt (see
            // sessions/auto-title.ts). Not a stream event — it just tells the
            // sidebar to refresh early instead of waiting for the turn to end.
            if (parsed?.kind === 'thread_title') {
              if (typeof parsed.title === 'string' && parsed.title) opts.onTitle?.(parsed.title);
              continue;
            }
            if (parsed?.kind === 'done') {
              dispatch({ type: 'STREAM_COMPLETE' });
              return lastContextUsage;
            }
            if (parsed?.kind === 'error') {
              const error = parsed.error ?? 'stream error';
              dispatch({ type: 'STREAM_ERROR', error });
              opts.onError?.(error);
              return lastContextUsage;
            }
            const inner = parsed?.event ?? parsed;
            const usage = routeEvent(inner, threadId, opts.onError);
            if (usage) lastContextUsage = usage;
          }
        }
        if (sawRunStart && !sawRunEnd) {
          dispatch({ type: 'RUN_ACTION', action: { type: 'RUN_INTERRUPTED', at: Date.now(), error: 'Stream disconnected' } });
          dispatch({ type: 'STREAM_COMPLETE' });
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          lastOutcomeRef.current = 'disconnected';
          return lastContextUsage;
        }
        // We only reach here after an ok response whose body we began reading,
        // then the read threw. A `TypeError` is a transport drop (WebKit surfaces
        // a dropped connection as "Load failed"): the request was accepted, the
        // backend keeps the run alive, and the re-attach poller reconciles the
        // result — so degrade softly rather than showing a scary error. (A true
        // *first-connection* cold-start rejection throws earlier from apiFetch and
        // is handled by the outer catch above.) Any other reader error is genuine
        // and has nothing to reconcile, so surface it.
        if (isTransportError(err)) {
          lastOutcomeRef.current = 'disconnected';
          if (sawRunStart && !sawRunEnd) {
            dispatch({ type: 'RUN_ACTION', action: { type: 'RUN_INTERRUPTED', at: Date.now(), error: 'Stream disconnected' } });
          }
          dispatch({ type: 'STREAM_COMPLETE' });
        } else {
          lastOutcomeRef.current = 'error';
          dispatch({ type: 'STREAM_ERROR', error: (err as Error).message });
          opts.onError?.((err as Error).message);
        }
      } finally {
        clearRequestRefs();
      }
      return lastContextUsage;
    },
    [routeEvent],
  );

  const abortStream = useCallback(async (source: 'user' | 'frontend' = 'frontend') => {
    const threadId = streamingThreadRef.current;
    const controller = abortRef.current;
    dispatch({ type: 'ABORT_STREAM', source });
    if (controller) {
      const abortRequest = threadId
        ? apiFetch(`/api/threads/${threadId}/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source }),
        }).catch(() => undefined)
        : Promise.resolve(undefined);
      controller.abort();
      await abortRequest;
    }
  }, []);

  const detachStream = useCallback(() => {
    abortRef.current = null;
    streamingThreadRef.current = null;
  }, []);

  /**
   * Cancel an active backend run by threadId, without depending on a local
   * fetch controller. Used when re-attaching to a run that was started in a
   * since-unmounted ChatPanel (e.g. after switching projects and back): the
   * original stream transport is gone, but the backend run is still alive and
   * must be aborted via the explicit /abort endpoint. The local reducer is
   * not touched — the next history poll reconciles state.
   */
  const stopRun = useCallback(async (threadId: string, source: 'user' | 'frontend' = 'user') => {
    try {
      await apiFetch(`/api/threads/${threadId}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
    } catch {
      /* polling reconciles state regardless */
    }
  }, []);

  return { state, startStream, abortStream, detachStream, stopRun, dispatch, setActiveThread, lastOutcomeRef };
}
