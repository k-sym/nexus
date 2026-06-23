/**
 * Mission Control status endpoint.
 *
 * Aggregates the project-less, cross-cutting signals for the Mission Control
 * landing view: memory-daemon health, the user's curated list of pi runtime
 * models (with per-provider auth health), and usage stats. The
 * legacy "persona roster" surface is gone - the model registry is the new
 * ground truth, filtered by the user's curation choices.
 */
import { FastifyInstance } from 'fastify';
import { daemon } from '../memory/client.js';
import { buildModelCatalog } from './pi.js';
import { getUsageStats } from '../codexbar.js';

export async function registerStatusRoutes(fastify: FastifyInstance) {
  fastify.get('/api/mission-control', async () => {
    // Memory daemon health (degrades gracefully if unreachable).
    let memory: Record<string, unknown>;
    try {
      memory = { ok: true, ...(await daemon.health()) };
    } catch (err: any) {
      memory = { ok: false, error: err.message };
    }

    // Curated models with per-provider credential health. We use the
    // same catalog + curation filter as /api/models so the dashboard
    // never shows models the user has explicitly disabled (and defaults
    // to auth-configured models when no curation has been saved yet).
    const appliedModels = fastify.modelCuration.apply(buildModelCatalog(fastify));
    const models = appliedModels.models;
    const modelCounts = {
      active: appliedModels.models.length,
      available: appliedModels.allModels.length,
    };

    const stats = await getUsageStats();

    return { memory, models, modelCounts, stats };
  });
}
