import { coerceArgs, type HermesRawToolCall, type HermesSessionMessage } from './client.js';

/**
 * SPIKE ARTIFACT (single-source-of-truth transport) — render a remote Hermes
 * transcript **directly** from `GET /api/sessions/{id}/messages`, with no local
 * pi-store round-trip and no `flattenEntries`.
 *
 * Hermes already persists everything we need: an `assistant` row carries
 * OpenAI-shape `tool_calls`, and each output is a `role:'tool'` row whose
 * `tool_call_id` matches the call `id`. This pairs them and inlines the result
 * into the assistant message's tool call — the exact shape the frontend's
 * `ToolCallTimeline` folds — so the standalone tool rows are dropped entirely
 * (no redundant raw-output bubbles to hide).
 *
 * The output shape mirrors `flattenEntries`' per-message projection
 * (`{role, content, tool_calls:[{id,name,args,status,result,...}]}`) so the
 * frontend renders it unchanged. Because it is a pure function of the live
 * Hermes payload, every load reflects the current transcript — there is no
 * local mirror to drift, which removes the "already-adopted sessions keep stale
 * entries" caveat of the import path.
 */

export interface TranscriptToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'succeeded' | 'failed' | 'interrupted';
  result?: string;
  is_error?: boolean;
}

export interface TranscriptMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string | null;
  tool_calls?: TranscriptToolCall[] | null;
  timestamp?: string;
}

function toTranscriptToolCall(
  call: HermesRawToolCall,
  results: Map<string, HermesSessionMessage>,
): TranscriptToolCall | null {
  const id = call.id ?? call.call_id;
  const name = call.function?.name ?? call.name;
  if (!id || !name) return null;
  const result = results.get(id);
  return {
    id,
    name,
    args: coerceArgs(call.function?.arguments ?? call.arguments),
    // A missing result means the transcript was captured mid-run (the tool
    // hadn't returned yet) — surface it as interrupted rather than succeeded.
    status: result ? (result.tool_call_id && isErrorResult(result) ? 'failed' : 'succeeded') : 'interrupted',
    ...(result ? { result: result.content, is_error: isErrorResult(result) } : {}),
  };
}

// Hermes `/messages` rows don't carry an explicit is_error flag today; a tool
// row is treated as an error only if a future field marks it. Kept as a single
// chokepoint so the heuristic can tighten without touching callers.
function isErrorResult(_result: HermesSessionMessage): boolean {
  return false;
}

export function hermesMessagesToTranscript(messages: HermesSessionMessage[]): TranscriptMessage[] {
  const results = new Map<string, HermesSessionMessage>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m);
  }

  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', content: m.content, timestamp: m.created_at });
    } else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? [])
        .map((call) => toTranscriptToolCall(call, results))
        .filter((call): call is TranscriptToolCall => call !== null);
      out.push({
        id: m.id,
        role: 'assistant',
        content: m.content,
        thinking: m.reasoning_content || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
        timestamp: m.created_at,
      });
    }
    // `tool` rows are folded into the owning assistant message above; `system`
    // rows are not richly rendered and are skipped.
  }
  return out;
}
