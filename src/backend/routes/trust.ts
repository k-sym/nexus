import type { FastifyInstance, FastifyReply } from 'fastify';
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { daemon, DaemonRequestError, type ReindexStats, type ClearNexusResult } from '../memory/client.js';
import { buildTrustSnapshot, type TrustSnapshotDependencies } from '../trust/snapshot.js';

export interface TrustDaemonClient {
  rebuildIndex(): Promise<ReindexStats>;
  clearNexusMemory(confirmation: string): Promise<ClearNexusResult>;
}

export interface TrustRouteOptions {
  config?: () => NexusConfig;
  daemonClient?: TrustDaemonClient;
  snapshot?: TrustSnapshotDependencies;
}

async function proxy<T>(reply: FastifyReply, operation: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DaemonRequestError) {
      const status = error.status === 400 || error.status === 409 ? error.status : 503;
      return reply.code(status).send({ error: status === 503 ? 'Memory daemon unavailable' : error.message });
    }
    return reply.code(503).send({ error: 'Memory daemon unavailable' });
  }
}

export async function registerTrustRoutes(fastify: FastifyInstance, options: TrustRouteOptions = {}): Promise<void> {
  const getConfig = options.config ?? loadConfig;
  const daemonClient = options.daemonClient ?? daemon;

  fastify.get('/api/trust', async () => buildTrustSnapshot(getConfig(), fastify.pi, options.snapshot));
  fastify.post('/api/trust/memory/rebuild', async (_request, reply) =>
    proxy(reply, () => daemonClient.rebuildIndex()));
  fastify.post('/api/trust/memory/clear-nexus', async (request, reply) => {
    const confirmation = (request.body as { confirmation?: string } | undefined)?.confirmation;
    if (confirmation !== 'CLEAR NEXUS MEMORY') {
      return reply.code(400).send({ error: 'Exact confirmation phrase required' });
    }
    return proxy(reply, () => daemonClient.clearNexusMemory(confirmation));
  });
}
