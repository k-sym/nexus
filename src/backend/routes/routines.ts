import { FastifyInstance } from 'fastify';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import { createHermesClient, type HermesFetch } from '../hermes/client.js';
import type { NexusConfig } from '@nexus/shared';

interface RoutinesRoutesOptions {
  fetchImpl?: HermesFetch;
}

// Read-only proxy over the partner adapter's routine fleet (`GET /v1/routines`,
// baker-internal#82) — the scheduled launchd jobs behind the morning brief,
// team pulse, etc. No start/stop controls in v1 (trust escalation, #54 there).
export function createRoutinesRoutes(load: () => NexusConfig = loadConfig, options: RoutinesRoutesOptions = {}) {
  return async function registerRoutinesRoutes(fastify: FastifyInstance) {
    const client = () => {
      const config = load();
      const url = resolveEnvVars(config.assistant.url || '').trim();
      const key = resolveAssistantKey(config);
      if (!url || !key) return undefined;
      return createHermesClient({ url, key, fetchImpl: options.fetchImpl });
    };

    // Fail-soft like the other assistant-backed reads: an unconfigured or
    // unreachable adapter yields an empty list plus a reason, never a 5xx —
    // the dashboard card renders its empty state instead of breaking.
    fastify.get('/api/routines', async () => {
      const hermes = client();
      if (!hermes) return { configured: false, routines: [] };
      try {
        const report = (await hermes.listRoutines()) as Record<string, unknown>;
        return { configured: true, routines: [], ...report };
      } catch (err: any) {
        return { configured: true, routines: [], error: err?.message || 'Routines fetch failed.' };
      }
    });

    fastify.get('/api/routines/:name', async (request, reply) => {
      const { name } = request.params as { name: string };
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      try {
        return await hermes.getRoutine(name);
      } catch (err: any) {
        const message: string = err?.message || 'Routine fetch failed.';
        reply.code(/not found/i.test(message) ? 404 : 502);
        return { error: message };
      }
    });
  };
}

export const registerRoutinesRoutes = createRoutinesRoutes();
