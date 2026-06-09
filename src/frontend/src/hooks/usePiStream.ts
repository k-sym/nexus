/**
 * usePiStream — frontend hook that subscribes to a chat turn's event
 * stream (NDJSON over HTTP), folds the events into a renderable
 * `state`, and supports a 409 + X-Confirm-Cancel conflict path.
 *
 * The reducer is ported from Zosma Cowork's usePiStream. The transport
 * is the Nexus variant: a regular fetch + ReadableStream consumer
 * (no Tauri Channel), since we go through the Fastify backend rather
 * than a Rust sidecar relay.
 */
import { useCallback, useReducer, useRef } from 'react';

/** Granular tool execution phase for richer status display. */
export type ToolPhase =
  | { type: 'calling'; toolName: string; args: Record<string, unknown> }
  | { type: 'executing'; toolName: string; partialOutput: string }
  | { type: 'done'; toolName: string }
  | { type: 'error'; toolName: string; message: string };

export interface StreamMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: 'running' | 'completed' | 'error';
    result?: string;
    is_error?: boolean;
  }>;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp: number;
  isStreaming?: boolean;
}

export interface StreamState {
  messages: StreamMessage[];
  streamingMessage: StreamMessage | null;
  isRunning: boolean;
  status: 'idle' | 'thinking' | 'tool_call' | 'responding' | 'error';
  error: string | null;
}

export type StreamAction =
  | { type: 'START_STREAM'; prompt: string }
  | { type: 'TEXT_DELTA'; delta: string }
  | { type: 'THINKING_DELTA'; delta: string }
  | { type: 'TOOL_CALL_START'; toolCall: { id: string; name: string; args: Record<string, unknown> } }
  | { type: 'TOOL_CALL_UPDATE'; id: string; patch: Record<string, unknown> }
  | { type: 'TOOL_PARTIAL_OUTPUT'; id: string; partialOutput: string }
  | { type: 'MESSAGE_END' }
  | { type: 'STREAM_COMPLETE' }
  | { type: 'STREAM_ERROR'; error: string }
  | { type: 'ABORT_STREAM' }
  | { type: 'RESET' };

export const INITIAL_STATE: StreamState = {
  messages: [],
  streamingMessage: null,
  isRunning: false,
  status: 'idle',
  error: null,
};

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function makeId(): string {
  let out = '';
  for (let i = 0; i < 12; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
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
      return {
        ...state,
        streamingMessage: { ...m, content: m.content + action.delta },
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

    case 'MESSAGE_END':
      return state;

    case 'STREAM_COMPLETE': {
      const m = state.streamingMessage;
      if (!m) {
        return { ...state, isRunning: false, status: 'idle', streamingMessage: null };
      }
      const isEmpty = !m.content && !m.thinking && (!m.toolCalls || m.toolCalls.length === 0);
      if (isEmpty) {
        return { ...state, isRunning: false, status: 'idle', streamingMessage: null };
      }
      return {
        ...state,
        isRunning: false,
        status: 'idle',
        messages: [...state.messages, { ...m, isStreaming: false }],
        streamingMessage: null,
      };
    }

    case 'STREAM_ERROR':
      return { ...state, isRunning: false, status: 'error', error: action.error };

    case 'ABORT_STREAM': {
      const current = state.streamingMessage;
      const hasContent = current && (current.content || current.thinking || (current.toolCalls && current.toolCalls.length > 0));
      if (hasContent) {
        return {
          ...state,
          isRunning: false,
          status: 'idle',
          messages: [...state.messages, { ...current, isStreaming: false }],
          streamingMessage: null,
        };
      }
      return { ...state, isRunning: false, status: 'idle' };
    }

    case 'RESET':
      return INITIAL_STATE;

    default:
      return state;
  }
}

export class ChatBusyError extends Error {
  constructor(public readonly activeThreadId: string, public readonly activeTitle: string) {
    super(`Thread ${activeThreadId} is busy`);
    this.name = 'ChatBusyError';
  }
}

export function usePiStream() {
  const [state, dispatch] = useReducer(streamReducer, INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const routeEvent = useCallback((ev: any) => {
    const type = ev?.type;
    if (type === 'message_start') {
      // start a fresh assistant sub-bubble; reducer is single-bubble for now
      return;
    }
    if (type === 'message_update') {
      const ame = ev.assistantMessageEvent;
      if (!ame) return;
      if (ame.type === 'thinking_delta') dispatch({ type: 'THINKING_DELTA', delta: ame.delta });
      else if (ame.type === 'text_delta') dispatch({ type: 'TEXT_DELTA', delta: ame.delta });
      else if (ame.type === 'toolcall_end') {
        dispatch({ type: 'TOOL_CALL_START', toolCall: { id: ame.toolCall.id, name: ame.toolCall.name, args: ame.toolCall.arguments ?? {} } });
      } else if (ame.type === 'error') {
        const reason = ame.reason === 'aborted' ? 'Aborted' : 'Error';
        dispatch({ type: 'STREAM_ERROR', error: reason });
      }
    } else if (type === 'message_end') {
      dispatch({ type: 'MESSAGE_END' });
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
          is_error: ev.isError,
        },
      });
    } else if (type === 'agent_end' || type === 'done') {
      dispatch({ type: 'STREAM_COMPLETE' });
    } else if (type === 'error') {
      dispatch({ type: 'STREAM_ERROR', error: ev.message ?? 'Unknown error' });
    }
  }, []);

  const startStream = useCallback(
    async (threadId: string, text: string, opts: { confirmCancel?: boolean } = {}) => {
      dispatch({ type: 'START_STREAM', prompt: text });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let res: Response;
      try {
        res = await fetch(`/api/threads/${threadId}/messages/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.confirmCancel ? { 'X-Confirm-Cancel': 'true' } : {}),
          },
          body: JSON.stringify({ content: text }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          dispatch({ type: 'ABORT_STREAM' });
          return;
        }
        dispatch({ type: 'STREAM_ERROR', error: (err as Error).message });
        return;
      }
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        throw new ChatBusyError(body.activeThreadId ?? '', body.activeTitle ?? 'busy thread');
      }
      if (!res.ok || !res.body) {
        dispatch({ type: 'STREAM_ERROR', error: `HTTP ${res.status}` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
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
            if (parsed?.kind === 'done') {
              dispatch({ type: 'STREAM_COMPLETE' });
              return;
            }
            if (parsed?.kind === 'error') {
              dispatch({ type: 'STREAM_ERROR', error: parsed.error ?? 'stream error' });
              return;
            }
            const inner = parsed?.event ?? parsed;
            routeEvent(inner);
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          dispatch({ type: 'ABORT_STREAM' });
          return;
        }
        dispatch({ type: 'STREAM_ERROR', error: (err as Error).message });
      } finally {
        abortRef.current = null;
      }
    },
    [routeEvent],
  );

  const abortStream = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    dispatch({ type: 'ABORT_STREAM' });
  }, []);

  return { state, startStream, abortStream, dispatch };
}
