import { FastifyInstance } from 'fastify';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createPartnerClient, type PartnerAttentionResolveBody, type PartnerFetch } from '../partner/client.js';
import type { NexusConfig } from '@nexus/shared';

interface AttentionRoutesOptions {
  fetchImpl?: PartnerFetch;
}

/** The fail-soft list shape: what an unconfigured or unreachable partner yields. */
const EMPTY_LIST = { items: [] as unknown[], open: 0, seq: 0, alert_seq: 0 };

// Proxy over the partner's attention items — the "Needs you" collection
// (baker-internal#140, #477): what needs Keith, with the proposed next action
// and the verbs each surface may offer written into the record.
//
// Same shape as the drafts proxy on purpose: reads fail soft so a partner blip
// renders an empty card, writes pass the partner's status through so "not
// allowed in this state" (409) never reads as "the partner is down" (502). It
// holds no policy of its own: the closed verb set, the lens subset and every
// state check live in the partner's store. Nothing here can approve or send —
// the payload has no such verb and no code path renders one.
export function createAttentionRoutes(load: () => NexusConfig = loadConfig, options: AttentionRoutesOptions = {}) {
  return async function registerAttentionRoutes(fastify: FastifyInstance) {
    const client = () => {
      const config = load();
      const url = resolveEnvVars(config.assistant.url || '').trim();
      const key = resolveAssistantKey(config);
      if (!url || !key) return undefined;
      return createPartnerClient({ url, key, fetchImpl: options.fetchImpl });
    };

    fastify.get('/api/attention', async (request) => {
      const { status, since_seq } = request.query as { status?: string; since_seq?: string };
      const partner = client();
      if (!partner) return { configured: false, ...EMPTY_LIST };
      const sinceSeq = since_seq != null && since_seq !== '' && Number.isFinite(Number(since_seq)) ? Number(since_seq) : undefined;
      try {
        const body = (await partner.listAttention(status, sinceSeq)) as Record<string, unknown>;
        return { configured: true, ...EMPTY_LIST, ...body };
      } catch (err: any) {
        return { configured: true, ...EMPTY_LIST, error: err?.message || 'Attention fetch failed.' };
      }
    });

    fastify.get('/api/attention/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const partner = client();
      if (!partner) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await partner.getAttention(id);
      } catch (err: any) {
        reply.code(err?.status === 404 ? 404 : 502);
        return { error: extractDetail(err?.message) || 'Attention fetch failed.' };
      }
    });

    // A write: the person who tapped is owed the truth. The partner answers 202
    // while a `draft` verb is still running (the item sits `resolving`); that
    // status is passed through so the phone can tell "started" from "done".
    fastify.post('/api/attention/:id/resolve', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as {
        verb?: unknown; by?: unknown; surface?: unknown; until?: unknown; preset?: unknown;
      };
      if (typeof body.verb !== 'string' || !body.verb.trim()) {
        reply.code(400);
        return { error: 'verb (string) is required' };
      }
      const partner = client();
      if (!partner) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      const payload: PartnerAttentionResolveBody = {
        verb: body.verb.trim(),
        by: typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 40) : 'nexus',
      };
      if (typeof body.surface === 'string' && body.surface.trim()) payload.surface = body.surface.trim().slice(0, 16);
      if (typeof body.until === 'number' && Number.isFinite(body.until)) payload.until = Math.floor(body.until);
      if (typeof body.preset === 'string' && body.preset.trim()) payload.preset = body.preset.trim();
      try {
        const result = await partner.resolveAttention(id, payload);
        reply.code(result.status);
        return result.body;
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : 502;
        reply.code(status === 400 || status === 404 || status === 409 ? status : 502);
        return { error: extractDetail(err?.message) || 'Attention resolve failed.' };
      }
    });
  };
}

// The partner answers FastAPI-style `{"detail": "..."}`; surface the sentence,
// not the JSON, because this string is shown verbatim on the card.
function extractDetail(message?: string): string | undefined {
  if (!message) return undefined;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON — use as-is */
  }
  return message;
}

export const registerAttentionRoutes = createAttentionRoutes();
