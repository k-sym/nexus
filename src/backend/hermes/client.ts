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
  streamChatCompletions(messages: Array<{ role: string; content: string }>): AsyncIterable<string>;
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
