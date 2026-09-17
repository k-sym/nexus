import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createPartnerClient, type PartnerAttentionResolveBody, type PartnerFetch } from '../partner/client.js';
import { daemon, type DaemonRecallItem } from '../memory/client.js';
import { attentionOriginJson, attentionThreadTitle, buildAttentionFirstTurn, type FiledAttentionItem } from '../attention/file.js';
import type { ChatThread, NexusConfig, OriginSessionResult } from '@nexus/shared';

interface AttentionRoutesOptions {
  fetchImpl?: PartnerFetch;
  /** Test seam for the vault-page lookup; defaults to the memory daemon's title search. */
  searchPages?: (title: string) => Promise<Array<Pick<DaemonRecallItem, 'id' | 'title' | 'body'>>>;
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

    // "Show the page" (#477 slice 6a, design D21): the item's vault page is a
    // memory in the daemon's global namespace, filed by the producer under the
    // exact title in `links.vault_page`. Look it up by that title and hand
    // back the markdown; the phone renders it. Read-only.
    fastify.get('/api/attention/:id/page', async (request, reply) => {
      const { id } = request.params as { id: string };
      const partner = client();
      if (!partner) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      let item: FiledAttentionItem;
      try {
        item = (await partner.getAttention(id)) as FiledAttentionItem;
      } catch (err: any) {
        reply.code(err?.status === 404 ? 404 : 502);
        return { error: extractDetail(err?.message) || 'Attention fetch failed.' };
      }
      const title = item?.links?.vault_page?.trim();
      if (!title) {
        reply.code(404);
        return { error: 'This item has no page.' };
      }
      const search = options.searchPages ?? (async (q: string) => (await daemon.search(q, { namespace: 'global' }, 5)).items);
      let hits: Array<Pick<DaemonRecallItem, 'id' | 'title' | 'body'>>;
      try {
        hits = await search(title);
      } catch (err: any) {
        reply.code(502);
        return { error: `Memory daemon unavailable — ${err?.message || 'search failed'}` };
      }
      const wanted = title.toLowerCase();
      const page = hits.find((h) => (h.title ?? '').trim().toLowerCase() === wanted) ?? null;
      if (!page || !page.body) {
        reply.code(404);
        return { error: `No page titled "${title}" in the vault.` };
      }
      return { title: page.title ?? title, body: page.body, memory_id: page.id, item_id: id };
    });

    // "File as a to-do" (#477 slice 6a, design D20): the item becomes a Board
    // session on the chosen project — a thread stamped with the item as its
    // origin plus a composed first turn the client sends as the seed — and the
    // item is dismissed on the partner (its ledger records who filed it; the
    // thread records what it became). A dismiss the partner refuses (already
    // resolved) does not undo the filing: the to-do is the point.
    fastify.post('/api/attention/:id/file', async (request, reply): Promise<OriginSessionResult | { error: string }> => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { project_id?: unknown; by?: unknown; surface?: unknown };
      if (typeof body.project_id !== 'string' || !body.project_id.trim()) {
        reply.code(400);
        return { error: 'project_id (string) is required' };
      }
      const db = fastify.db;
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.project_id.trim()) as { id: string } | undefined;
      if (!project) {
        reply.code(404);
        return { error: 'Project not found' };
      }
      const partner = client();
      if (!partner) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      let item: FiledAttentionItem;
      try {
        item = (await partner.getAttention(id)) as FiledAttentionItem;
      } catch (err: any) {
        reply.code(err?.status === 404 ? 404 : 502);
        return { error: extractDetail(err?.message) || 'Attention fetch failed.' };
      }
      if (!item?.id) {
        reply.code(502);
        return { error: 'The partner returned no item.' };
      }

      const nowIso = new Date().toISOString();
      const thread: ChatThread = {
        id: randomUUID(),
        project_id: project.id,
        title: attentionThreadTitle(item),
        created_at: nowIso,
        updated_at: nowIso,
        archived_at: null,
        attention_item: attentionOriginJson(item),
      };
      db.prepare(
        'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at, attention_item) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(thread.id, thread.project_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at, thread.attention_item);

      const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 40) : 'nexus';
      const surface = typeof body.surface === 'string' && body.surface.trim() ? body.surface.trim().slice(0, 16) : undefined;
      try {
        // D34: the partner's ledger records what the item became (the thread id).
        await partner.resolveAttention(id, { verb: 'dismiss', by, ...(surface ? { surface } : {}), result: { filed_as: thread.id } });
      } catch (err: any) {
        // 409 = already resolved; anything else is the partner's problem, not the to-do's.
        fastify.log?.warn?.({ id, status: err?.status }, 'attention file: dismiss refused');
      }

      return { thread, firstTurn: buildAttentionFirstTurn(item) };
    });

    // A write: the person who tapped is owed the truth. The partner answers 202
    // while a slow verb (`draft`, `close`) is still running (the item sits
    // `resolving`); that status is passed through so the phone can tell
    // "started" from "done". `close` is an external GitHub write run by the
    // partner's own `gh` (baker-internal D25); the phone and the web confirm
    // before sending it, and the lens never offers it.
    fastify.post('/api/attention/:id/resolve', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as {
        verb?: unknown; by?: unknown; surface?: unknown; until?: unknown; preset?: unknown; result?: unknown;
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
      // D34: a plain-object result rides along (Approve cleanup sends
      // `{ approved: true }`); anything else is dropped, as the partner would.
      if (isPlainObject(body.result)) payload.result = body.result;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
