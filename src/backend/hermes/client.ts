export type HermesFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HermesRunInput {
  input: string;
  sessionId?: string;
  sessionKey?: string;
  instructions?: string;
  conversationHistory?: unknown[];
  previousResponseId?: string;
}

export interface HermesRunStart {
  runId: string;
  status: string;
}

export interface HermesRunStatus {
  runId: string;
  status: string;
  sessionId?: string;
  model?: string;
  output?: string;
  usage?: unknown;
  error?: string;
}

export interface HermesResponsesInput {
  input: string;
  sessionId?: string;
  sessionKey?: string;
  previousResponseId?: string;
  instructions?: string;
  signal?: AbortSignal;
}

export type HermesResponseEvent =
  | { kind: 'created'; responseId?: string }
  | { kind: 'text_delta'; delta: string }
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'function_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'function_call_output'; callId: string; output: string; isError: boolean }
  | { kind: 'completed'; responseId?: string }
  | { kind: 'failed'; error: string };

export type HermesContentPart =
  | { type: 'text' | 'input_text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_image'; image_url: string };

export interface HermesSessionInput {
  sessionId: string;
  sessionKey?: string;
  title?: string;
}

export interface HermesSessionChatInput {
  sessionId: string;
  sessionKey?: string;
  input: string | HermesContentPart[];
  instructions?: string;
}

export interface HermesSessionChatResult {
  sessionId: string;
  output: string;
  usage?: unknown;
}

export interface HermesSessionChatStreamInput {
  sessionId: string;
  sessionKey?: string;
  input: string | HermesContentPart[];
  /** Ephemeral system prompt for this turn (Hermes `system_message`). */
  instructions?: string;
  signal?: AbortSignal;
}

/**
 * Normalized events from `POST /api/sessions/{id}/chat/stream`. The wire form is
 * SSE `event:`/`data:` frames; the tool events carry `tool_name`/`preview`/`args`
 * but NO tool_call_id (older `_tool_progress` callback), so callers correlate
 * `tool_started`→`tool_completed` themselves (FIFO by name) and take authoritative
 * ids + full output from `/api/sessions/{id}/messages` on reload.
 */
export type HermesChatStreamEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'tool_started'; toolName: string; args?: Record<string, unknown> }
  | { kind: 'tool_completed'; toolName: string; preview: string; isError: boolean }
  | { kind: 'completed' }
  | { kind: 'failed'; error: string };

export interface HermesListSessionsInput {
  limit?: number;
  offset?: number;
  /**
   * Restrict to a single source class (e.g. 'tui'). The api_server
   * /api/sessions endpoint matches one source per request and has no
   * multi-source or exclude filter, so callers wanting several sources fetch
   * one per source and merge.
   */
  source?: string;
  includeChildren?: boolean;
}

export interface HermesListedSession {
  id: string;
  title?: string;
  source?: string;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  end_reason?: string | null;
  // The api_server /api/sessions projection carries epoch-second timestamps
  // (not ISO created_at/updated_at), a first-user-message preview, and often a
  // null title. publicRemoteSession() maps these onto the rail's shape.
  started_at?: number;
  last_active?: number;
  ended_at?: number | null;
  preview?: string;
  message_count?: number;
}

export interface HermesListSessionsResult {
  sessions: HermesListedSession[];
  nextOffset: number | null;
}

/**
 * A tool call as Hermes persists it — OpenAI `tool_calls` shape (some providers
 * flatten `name`/`arguments` onto the object instead of nesting under
 * `function`). `arguments` is a JSON string. Hermes JSON-parses the column into
 * this array before returning it from `/api/sessions/{id}/messages`.
 */
export interface HermesRawToolCall {
  id?: string;
  call_id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string;
}

export interface HermesSessionMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at?: string;
  // Present on `assistant` rows that call tools, and on `tool` result rows.
  // Nexus used to discard these, flattening tool output into assistant text
  // bubbles when adopting a remote session.
  tool_calls?: HermesRawToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  reasoning_content?: string;
}

export interface HermesCapabilities {
  runs: boolean;
  runEvents: boolean;
  runStop: boolean;
  sessions: boolean;
  responses: boolean;
  chatCompletions: boolean;
  sessionKeyHeader?: string;
}

export interface HermesClient {
  capabilities(): Promise<HermesCapabilities>;
  startRun(input: HermesRunInput): Promise<HermesRunStart>;
  getRun(runId: string): Promise<HermesRunStatus>;
  stopRun(runId: string): Promise<void>;
  createSession(input: HermesSessionInput): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string): Promise<void>;
  listSessions(input?: HermesListSessionsInput): Promise<HermesListSessionsResult>;
  getSession(sessionId: string): Promise<HermesListedSession | null>;
  getSessionMessages(sessionId: string): Promise<HermesSessionMessage[]>;
  sessionChat(input: HermesSessionChatInput): Promise<HermesSessionChatResult>;
  sessionChatStream(input: HermesSessionChatStreamInput): AsyncIterable<HermesChatStreamEvent>;
  streamChatCompletions(messages: Array<{ role: string; content: string }>): AsyncIterable<string>;
  streamResponses(input: HermesResponsesInput): AsyncIterable<HermesResponseEvent>;
}

interface CreateHermesClientOptions {
  url: string;
  key: string;
  fetchImpl?: HermesFetch;
}

export function normalizeHermesBaseUrl(url: string): string {
  let trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/chat/completions')) trimmed = trimmed.slice(0, -'/v1/chat/completions'.length);
  else if (trimmed.endsWith('/v1/responses')) trimmed = trimmed.slice(0, -'/v1/responses'.length);
  else if (trimmed.endsWith('/v1')) trimmed = trimmed.slice(0, -'/v1'.length);
  return trimmed.replace(/\/+$/, '');
}

export function createHermesClient(options: CreateHermesClientOptions): HermesClient {
  const baseUrl = normalizeHermesBaseUrl(options.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const key = options.key;

  const jsonHeaders = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Hermes request failed with ${response.status}`);
    }
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }

  return {
    async capabilities(): Promise<HermesCapabilities> {
      const body = await requestJson('/v1/capabilities');
      const features = (body as any)?.features ?? {};
      const endpoints = (body as any)?.endpoints ?? {};
      return {
        runs: Boolean(features.run_submission),
        runEvents: Boolean(features.run_events_sse),
        runStop: Boolean(features.run_stop),
        sessions: Boolean(features.session_create || endpoints.session_create || endpoints.session_chat_stream),
        responses: Boolean(features.responses_api),
        chatCompletions: Boolean(features.chat_completions),
        sessionKeyHeader: (body as any)?.session_key_header,
      };
    },

    async startRun(input: HermesRunInput): Promise<HermesRunStart> {
      const body: Record<string, unknown> = { input: input.input };
      if (input.sessionId) body.session_id = input.sessionId;
      if (input.instructions) body.instructions = input.instructions;
      if (input.conversationHistory) body.conversation_history = input.conversationHistory;
      if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
      const response = await requestJson('/v1/runs', {
        method: 'POST',
        headers: jsonHeaders(input.sessionKey ? { 'X-Hermes-Session-Key': input.sessionKey } : {}),
        body: JSON.stringify(body),
      });
      return {
        runId: String((response as any).run_id ?? (response as any).runId ?? ''),
        status: String((response as any).status ?? 'started'),
      };
    },

    async getRun(runId: string): Promise<HermesRunStatus> {
      const response = await requestJson(`/v1/runs/${encodeURIComponent(runId)}`);
      const status: HermesRunStatus = {
        runId: String((response as any).run_id ?? (response as any).runId ?? runId),
        status: String((response as any).status ?? 'unknown'),
      };
      if ((response as any).session_id !== undefined) status.sessionId = (response as any).session_id;
      if ((response as any).model !== undefined) status.model = (response as any).model;
      if ((response as any).output !== undefined) status.output = (response as any).output;
      if ((response as any).usage !== undefined) status.usage = (response as any).usage;
      if ((response as any).error !== undefined) status.error = (response as any).error;
      return status;
    },

    async stopRun(runId: string): Promise<void> {
      await requestJson(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
    },

    async createSession(input: HermesSessionInput): Promise<{ sessionId: string }> {
      const body: Record<string, unknown> = { id: input.sessionId };
      if (input.title) body.title = input.title;
      const response = await requestJson('/api/sessions', {
        method: 'POST',
        headers: jsonHeaders(input.sessionKey ? { 'X-Hermes-Session-Key': input.sessionKey } : {}),
        body: JSON.stringify(body),
      });
      const session = (response as any)?.session ?? {};
      return { sessionId: String(session.id ?? input.sessionId) };
    },

    async deleteSession(sessionId: string): Promise<void> {
      await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    },

    async listSessions(input: HermesListSessionsInput = {}): Promise<HermesListSessionsResult> {
      const params = new URLSearchParams();
      if (input.limit !== undefined) params.set('limit', String(input.limit));
      if (input.offset !== undefined) params.set('offset', String(input.offset));
      if (input.source !== undefined) params.set('source', input.source);
      if (input.includeChildren !== undefined) params.set('include_children', String(input.includeChildren));
      const query = params.toString();
      const body = (await requestJson(`/api/sessions${query ? `?${query}` : ''}`)) as any;
      const sessions: HermesListedSession[] = Array.isArray(body) ? body : body?.sessions ?? body?.data ?? [];
      const rawNext = body?.next_offset ?? body?.nextOffset ?? null;
      const nextOffset = rawNext === null || rawNext === undefined ? null : Number(rawNext);
      return { sessions, nextOffset };
    },

    async getSession(sessionId: string): Promise<HermesListedSession | null> {
      const body = (await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`)) as any;
      const session = body?.session ?? body;
      return session && typeof session === 'object' ? (session as HermesListedSession) : null;
    },

    async getSessionMessages(sessionId: string): Promise<HermesSessionMessage[]> {
      const body = (await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)) as any;
      const messages = Array.isArray(body) ? body : body?.messages ?? body?.data ?? [];
      return messages as HermesSessionMessage[];
    },

    async sessionChat(input: HermesSessionChatInput): Promise<HermesSessionChatResult> {
      const body: Record<string, unknown> = { input: input.input };
      if (input.instructions) body.instructions = input.instructions;
      const response = await requestJson(`/api/sessions/${encodeURIComponent(input.sessionId)}/chat`, {
        method: 'POST',
        headers: jsonHeaders(input.sessionKey ? { 'X-Hermes-Session-Key': input.sessionKey } : {}),
        body: JSON.stringify(body),
      });
      return {
        sessionId: String((response as any).session_id ?? (response as any).sessionId ?? input.sessionId),
        output: String((response as any).message?.content ?? (response as any).output ?? ''),
        usage: (response as any).usage,
      };
    },

    async *sessionChatStream(input: HermesSessionChatStreamInput): AsyncIterable<HermesChatStreamEvent> {
      const body: Record<string, unknown> = { message: input.input };
      if (input.instructions) body.system_message = input.instructions;
      const response = await fetchImpl(`${baseUrl}/api/sessions/${encodeURIComponent(input.sessionId)}/chat/stream`, {
        method: 'POST',
        headers: jsonHeaders(input.sessionKey ? { 'X-Hermes-Session-Key': input.sessionKey } : {}),
        body: JSON.stringify(body),
        signal: input.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Hermes request failed with ${response.status}`);
      }
      if (!response.body) throw new Error('Hermes response did not include a stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      // SSE frames are separated by a blank line; a frame may span reads.
      const drain = function* (buffer: string, flushTail: boolean): Generator<HermesChatStreamEvent> {
        let rest = buffer;
        let sep = rest.indexOf('\n\n');
        while (sep !== -1) {
          const frame = rest.slice(0, sep);
          rest = rest.slice(sep + 2);
          const ev = parseChatStreamFrame(frame);
          if (ev) yield ev;
          sep = rest.indexOf('\n\n');
        }
        if (flushTail && rest.trim()) {
          const ev = parseChatStreamFrame(rest);
          if (ev) yield ev;
          rest = '';
        }
        pending = rest;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        yield* drain(pending, false);
      }
      yield* drain(pending, true);
    },

    async *streamChatCompletions(messages: Array<{ role: string; content: string }>): AsyncIterable<string> {
      const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ model: 'hermes-agent', stream: true, messages }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Hermes request failed with ${response.status}`);
      }
      if (!response.body) throw new Error('Hermes response did not include a stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const delta = extractOpenAiDelta(line);
          if (delta) yield delta;
        }
      }
      const delta = extractOpenAiDelta(pending);
      if (delta) yield delta;
    },

    async *streamResponses(input: HermesResponsesInput): AsyncIterable<HermesResponseEvent> {
      const body: Record<string, unknown> = { input: input.input, stream: true };
      if (input.sessionId) body.session_id = input.sessionId;
      if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
      if (input.instructions) body.instructions = input.instructions;
      const response = await fetchImpl(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: jsonHeaders(input.sessionKey ? { 'X-Hermes-Session-Key': input.sessionKey } : {}),
        body: JSON.stringify(body),
        signal: input.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Hermes request failed with ${response.status}`);
      }
      if (!response.body) throw new Error('Hermes response did not include a stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const flush = function* (line: string): Generator<HermesResponseEvent> {
        const ev = parseResponsesEvent(line);
        if (ev) yield ev;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) yield* flush(line);
      }
      yield* flush(pending);
    },
  };
}

export function extractOpenAiDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'data: [DONE]') return '';
  const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText) return '';
  try {
    const parsed = JSON.parse(jsonText);
    return parsed?.choices?.[0]?.delta?.content
      ?? parsed?.choices?.[0]?.message?.content
      ?? parsed?.delta
      ?? parsed?.content
      ?? '';
  } catch {
    return '';
  }
}

export function parseResponsesEvent(line: string): HermesResponseEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'data: [DONE]') return null;
  const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText) return null;
  let e: any;
  try { e = JSON.parse(jsonText); } catch { return null; }
  switch (e?.type) {
    case 'response.created':
      return { kind: 'created', responseId: e.response?.id };
    case 'response.output_text.delta':
      return typeof e.delta === 'string' ? { kind: 'text_delta', delta: e.delta } : null;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return typeof e.delta === 'string' ? { kind: 'reasoning_delta', delta: e.delta } : null;
    case 'response.output_item.done': {
      const item = e.item ?? {};
      if (item.type === 'function_call') {
        return {
          kind: 'function_call',
          id: String(item.id ?? item.call_id ?? ''),
          name: String(item.name ?? ''),
          args: coerceArgs(item.arguments),
        };
      }
      if (item.type === 'function_call_output') {
        return {
          kind: 'function_call_output',
          callId: String(item.call_id ?? item.id ?? ''),
          output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          isError: Boolean(item.is_error),
        };
      }
      return null;
    }
    case 'response.completed':
      return { kind: 'completed', responseId: e.response?.id };
    case 'response.failed':
    case 'response.incomplete':
      return { kind: 'failed', error: String(e.response?.error?.message ?? e.error?.message ?? 'Assistant run failed.') };
    default:
      return null;
  }
}

/**
 * Parse one SSE frame from `/api/sessions/{id}/chat/stream` into a normalized
 * event. A frame is `event: <name>\ndata: <json>` (data may be absent). Keepalive
 * comment frames (`: keepalive`) and lifecycle-only events (run.started,
 * message.started, assistant.completed) return null.
 */
export function parseChatStreamFrame(frame: string): HermesChatStreamEvent | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue; // blank or SSE comment (keepalive)
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (!eventName) return null;
  let data: any = {};
  if (dataLines.length > 0) {
    try { data = JSON.parse(dataLines.join('\n')); } catch { data = {}; }
  }
  switch (eventName) {
    case 'assistant.delta':
      return typeof data.delta === 'string' && data.delta ? { kind: 'text_delta', delta: data.delta } : null;
    case 'tool.progress':
      // Reasoning is streamed as a progress event under the synthetic "_thinking" tool.
      return data.tool_name === '_thinking' && typeof data.delta === 'string' && data.delta
        ? { kind: 'reasoning_delta', delta: data.delta }
        : null;
    case 'tool.started':
      return { kind: 'tool_started', toolName: String(data.tool_name ?? ''), args: coerceArgs(data.args) };
    case 'tool.completed':
      return { kind: 'tool_completed', toolName: String(data.tool_name ?? ''), preview: String(data.preview ?? ''), isError: false };
    case 'tool.failed':
      return { kind: 'tool_completed', toolName: String(data.tool_name ?? ''), preview: String(data.preview ?? ''), isError: true };
    case 'run.completed':
    case 'done':
      return { kind: 'completed' };
    case 'error':
      return { kind: 'failed', error: String(data.message ?? 'Assistant run failed.') };
    default:
      return null;
  }
}

export function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
}
