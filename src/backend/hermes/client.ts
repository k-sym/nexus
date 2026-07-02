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
  sessionChat(input: HermesSessionChatInput): Promise<HermesSessionChatResult>;
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

function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
}
