import { FastifyInstance } from 'fastify';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createHermesClient, type HermesFetch } from '../hermes/client.js';
import type { NexusConfig } from '@nexus/shared';

interface NightQueueRoutesOptions {
  fetchImpl?: HermesFetch;
}

// Read-only proxy over the partner adapter's night-queue board (`GET
// /v1/night-queue`, baker-internal#111) — what the overnight runner (#55) did,
// what is queued for tonight, and which of its PRs are still open for Keith.
// No controls: the queue is filled by minting a label in daytime discussion,
// never from a dashboard.
export function createNightQueueRoutes(
  load: () => NexusConfig = loadConfig,
  options: NightQueueRoutesOptions = {},
) {
  return async function registerNightQueueRoutes(fastify: FastifyInstance) {
    const client = () => {
      const config = load();
      const url = resolveEnvVars(config.assistant.url || '').trim();
      const key = resolveAssistantKey(config);
      if (!url || !key) return undefined;
      return createHermesClient({ url, key, fetchImpl: options.fetchImpl });
    };

    // Fail-soft like /api/routines: an unconfigured or unreachable adapter
    // yields empty sections plus a reason, never a 5xx. `available: false` is
    // the adapter's own "no night has run yet" and is passed through as data —
    // the card distinguishes "nothing has happened" from "I cannot tell".
    fastify.get('/api/night-queue', async (request) => {
      const { nights } = request.query as { nights?: string };
      const hermes = client();
      const empty = { nights: [], queue: [], open_prs: [] };
      if (!hermes) return { configured: false, available: false, ...empty };
      try {
        const parsed = Number(nights);
        const report = (await hermes.listNightQueue(
          Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
        )) as Record<string, unknown>;
        return { configured: true, available: false, ...empty, ...report };
      } catch (err: any) {
        return {
          configured: true,
          available: false,
          ...empty,
          error: err?.message || 'Night queue fetch failed.',
        };
      }
    });

    fastify.get('/api/night-queue/nights/:nightId', async (request, reply) => {
      const { nightId } = request.params as { nightId: string };
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.getNight(nightId);
      } catch (err: any) {
        const message: string = err?.message || 'Night fetch failed.';
        reply.code(/not found/i.test(message) ? 404 : 502);
        return { error: message };
      }
    });
  };
}

export const registerNightQueueRoutes = createNightQueueRoutes();
