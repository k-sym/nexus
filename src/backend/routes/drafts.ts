import { FastifyInstance } from 'fastify';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createHermesClient, type HermesFetch } from '../hermes/client.js';
import type { NexusConfig } from '@nexus/shared';

interface DraftsRoutesOptions {
  fetchImpl?: HermesFetch;
}

// Proxy over the partner adapter's outbound draft queue (baker-internal#42) —
// replies the partner has proposed but may not send. Approving here is what
// transmits the email, so unlike the routines proxy this surface has writes.
//
// It holds no policy of its own on purpose. Every guard (approved status,
// content unchanged since approval, approval freshness, draft age) lives in the
// partner's own send path, which re-checks all of them in a separate process
// after this call. A bug here can at worst approve something a human tapped on;
// it cannot manufacture a send.
export function createDraftsRoutes(load: () => NexusConfig = loadConfig, options: DraftsRoutesOptions = {}) {
  return async function registerDraftsRoutes(fastify: FastifyInstance) {
    const client = () => {
      const config = load();
      const url = resolveEnvVars(config.assistant.url || '').trim();
      const key = resolveAssistantKey(config);
      if (!url || !key) return undefined;
      return createHermesClient({ url, key, fetchImpl: options.fetchImpl });
    };

    // Reads fail soft, like the routines card: an unreachable adapter renders an
    // empty state rather than breaking the dashboard.
    fastify.get('/api/drafts', async (request) => {
      const { status } = request.query as { status?: string };
      const hermes = client();
      if (!hermes) return { configured: false, drafts: [], pending: 0 };
      try {
        const body = (await hermes.listDrafts(status)) as Record<string, unknown>;
        return { configured: true, drafts: [], pending: 0, ...body };
      } catch (err: any) {
        return { configured: true, drafts: [], pending: 0, error: err?.message || 'Draft fetch failed.' };
      }
    });

    fastify.get('/api/drafts/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.getDraft(id);
      } catch (err: any) {
        reply.code(err?.status === 404 ? 404 : 502);
        return { error: err?.message || 'Draft fetch failed.' };
      }
    });

    // Writes do NOT fail soft: a person tapped approve and is owed the truth
    // about whether the email left. The adapter's status is passed through so
    // "already decided" (409) never reads as "send failed" (502).
    const decide = (action: 'approve' | 'reject') =>
      async function handler(request: any, reply: any) {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { by?: string; note?: string };
        const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 40) : 'nexus';
        const hermes = client();
        if (!hermes) {
          reply.code(400);
          return { error: 'Assistant URL and key must be configured in Settings.' };
        }
        try {
          return action === 'approve'
            ? await hermes.approveDraft(id, by)
            : await hermes.rejectDraft(id, by, body.note);
        } catch (err: any) {
          const status = typeof err?.status === 'number' ? err.status : 502;
          reply.code(status === 404 || status === 409 ? status : 502);
          return { error: extractDetail(err?.message) || `Draft ${action} failed.` };
        }
      };

    // Edit-before-send (baker-internal#97). A write like approve/reject: the
    // user is owed the truth about whether their new text was saved, so no
    // fail-soft here, and the adapter's status passes through — an edit of a
    // sent draft is a 409, not a 502.
    fastify.patch('/api/drafts/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { body?: string; by?: string };
      if (typeof body.body !== 'string') {
        reply.code(400);
        return { error: 'body (string) is required' };
      }
      const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 40) : 'nexus';
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.editDraft(id, body.body, by);
      } catch (err: any) {
        const status = typeof err?.status === 'number' ? err.status : 502;
        reply.code(status === 404 || status === 409 || status === 400 ? status : 502);
        return { error: extractDetail(err?.message) || 'Draft edit failed.' };
      }
    });

    fastify.post('/api/drafts/:id/approve', decide('approve'));
    fastify.post('/api/drafts/:id/reject', decide('reject'));
  };
}

// The adapter answers FastAPI-style `{"detail": "..."}`; surface the sentence,
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

export const registerDraftsRoutes = createDraftsRoutes();
