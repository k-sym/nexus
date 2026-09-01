import { FastifyInstance } from 'fastify';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createHermesClient, type HermesFetch } from '../hermes/client.js';
import type { NexusConfig } from '@nexus/shared';

/** The adapter answers errors as FastAPI's `{"detail": "..."}`. Unwrap it so
 * the card shows "this issue is already queued" rather than raw JSON. */
function detailOf(err: any, fallback: string): string {
  const raw: string = err?.message || fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON — the message is already human-readable */
  }
  return raw;
}

interface WorkshopRoutesOptions {
  fetchImpl?: HermesFetch;
}

/**
 * Readiness workshop (baker-internal#111) — the daylight half of the night
 * queue. Three reads, one conversation, and one write.
 *
 * The write, `POST /api/night-queue/arm`, is the moment an issue joins
 * tonight's queue for an unattended agent. It is a pure passthrough on
 * purpose: every guard (excluded repos, unresolved `<TODO:`, a spec the
 * planner would filter as its own bookkeeping, comment-before-label ordering,
 * the autonomy ledger) lives in the partner adapter, where the trust machinery
 * already is. Re-implementing any of it here would give two answers to one
 * question, and this side would be the one nobody tested against a real night.
 */
export function createWorkshopRoutes(
  load: () => NexusConfig = loadConfig,
  options: WorkshopRoutesOptions = {},
) {
  return async function registerWorkshopRoutes(fastify: FastifyInstance) {
    const client = () => {
      const config = load();
      const url = resolveEnvVars(config.assistant.url || '').trim();
      const key = resolveAssistantKey(config);
      if (!url || !key) return undefined;
      return createHermesClient({ url, key, fetchImpl: options.fetchImpl });
    };

    // Reads: fail-soft, matching /api/routines and /api/night-queue.
    fastify.get('/api/night-queue/readiness', async () => {
      const hermes = client();
      if (!hermes) return { configured: false, criteria: [] };
      try {
        return { configured: true, ...(await hermes.nightQueueReadiness() as object) };
      } catch (err: any) {
        return { configured: true, criteria: [], error: err?.message || 'Readiness fetch failed.' };
      }
    });

    fastify.get('/api/night-queue/candidates', async () => {
      const hermes = client();
      if (!hermes) return { configured: false, candidates: [] };
      try {
        return { configured: true, ...(await hermes.nightQueueCandidates() as object) };
      } catch (err: any) {
        return { configured: true, candidates: [], error: err?.message || 'Candidate fetch failed.' };
      }
    });

    // Assessment costs a model call, so it is a POST the user triggers, and a
    // failure is an error rather than an empty verdict: "I could not judge
    // this" must never render as "nothing is wrong with it".
    fastify.post('/api/night-queue/assess', async (request, reply) => {
      const { repo, number } = (request.body ?? {}) as { repo?: string; number?: number };
      if (!repo || typeof number !== 'number') {
        reply.code(400);
        return { error: 'repo (string) and number (number) are required.' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.assessIssue(repo, number);
      } catch (err: any) {
        // The client attaches the upstream status (see hermes/client.ts) —
        // 404 for an unknown issue, 502 for an unreadable verdict. Use it
        // rather than sniffing the message.
        reply.code(err?.status ?? 502);
        return { error: detailOf(err, 'Assessment failed.') };
      }
    });

    // Opening a conversation about an issue. It creates an assistant session
    // and writes nothing to GitHub, so it is not gated like the arm below —
    // but it is a POST because it has an effect, and the adapter's 403 for an
    // excluded repo reaches the client unchanged.
    //
    // The seed (the readiness bar plus the issue text inside its fence) is
    // composed by the adapter, never here and never by the client: a second
    // spelling of that fence would be an injection path into the very decision
    // the conversation exists to inform.
    fastify.post('/api/night-queue/discuss', async (request, reply) => {
      const { repo, number, draft } = (request.body ?? {}) as {
        repo?: string; number?: number; draft?: string;
      };
      if (!repo || typeof number !== 'number') {
        reply.code(400);
        return { error: 'repo (string) and number (number) are required.' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.discussIssue({
          repo, number,
          draft: typeof draft === 'string' ? draft : undefined,
        });
      } catch (err: any) {
        reply.code(err?.status ?? 502);
        return { error: detailOf(err, 'Could not open the conversation.') };
      }
    });

    // Getting the agreed wording back out of that conversation
    // (baker-internal#132). A read, and the whole point of it is that nothing
    // between the transcript and the draft field is allowed to be creative:
    // the adapter returns the last fenced block verbatim or says it found
    // none. The card puts the result in the EDITABLE draft, where every arm
    // guard still applies to it.
    //
    // `:sessionId` is the ADAPTER session id from `discuss`, not the nexus id
    // the chat endpoints are keyed by — the card holds both.
    fastify.get('/api/night-queue/discuss/:sessionId/comment', async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.discussComment(sessionId);
      } catch (err: any) {
        // 404 is "no workshop conversation with that id" and reads quite
        // differently from "the adapter is down". Keep them apart.
        reply.code(err?.status ?? 502);
        return { error: detailOf(err, 'Could not read the comment.') };
      }
    });

    // The write. The adapter's status reaches the card unchanged, because the
    // card branches on it: 403 is standing policy, 409 is already queued or
    // closed, 400 is a spec the adapter refused. Flattening them all to 502
    // would turn four different conversations into one shrug.
    fastify.post('/api/night-queue/arm', async (request, reply) => {
      const { repo, number, comment, decided_by } = (request.body ?? {}) as {
        repo?: string; number?: number; comment?: string; decided_by?: string;
      };
      if (!repo || typeof number !== 'number' || typeof comment !== 'string') {
        reply.code(400);
        return { error: 'repo, number and comment are required.' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        // Forwarded so the autonomy ledger records WHERE the decision was
        // made — a phone tap and a desk session are the same write but not the
        // same act. Defaults to the desktop's value when a client omits it.
        return await hermes.armIssue({
          repo, number, comment,
          decided_by: typeof decided_by === 'string' && decided_by.trim()
            ? decided_by.trim().slice(0, 64)
            : 'nexus-workshop',
        });
      } catch (err: any) {
        reply.code(err?.status ?? 502);
        return { error: detailOf(err, 'Arming failed.') };
      }
    });
  };
}

export const registerWorkshopRoutes = createWorkshopRoutes();
