/**
 * Models routes — surfaces the pi runtime's ModelRegistry.
 *
 * The runtime knows which models are available and which providers have
 * auth configured. The frontend uses this to populate the model selector
 * and the orchestrator's "pick a model" picker.
 */
import { FastifyInstance } from 'fastify';
import type { AppliedModelCuration } from '../pi/model-curation';

export function buildModelCatalog(fastify: FastifyInstance) {
  const all = fastify.pi.models.getAll();
  const available = fastify.pi.models.getAvailable();
  const configuredKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
  return all.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    configured: configuredKeys.has(`${m.provider}/${m.id}`),
  }));
}

function toModelsResponse(applied: AppliedModelCuration) {
  return {
    allModels: applied.allModels,
    models: applied.models,
    enabledModelKeys: applied.enabledKeys,
    customized: applied.customized,
  };
}

export async function registerPiRoutes(fastify: FastifyInstance) {
  fastify.get('/api/models', async () => {
    return toModelsResponse(fastify.modelCuration.apply(buildModelCatalog(fastify)));
  });

  fastify.put('/api/models/curation', async (request, reply) => {
    const body = request.body as { enabledModelKeys?: unknown };
    if (!Array.isArray(body.enabledModelKeys)) {
      reply.code(400);
      return { error: 'enabledModelKeys must be an array' };
    }
    const all = fastify.pi.models.getAll();
    const known = new Set(all.map((m) => `${m.provider}/${m.id}`));
    const enabled = body.enabledModelKeys.filter((key): key is string => typeof key === 'string' && known.has(key));
    fastify.modelCuration.save(enabled);
    return toModelsResponse(fastify.modelCuration.apply(buildModelCatalog(fastify)));
  });

  /**
   * Set the active model. Stored in the runtime's session state when the
   * next session is created; for v1 we just acknowledge — the chat route
   * reads `models` from the request and the user picks per-thread.
   */
  fastify.post('/api/models/active', async (request) => {
    const body = request.body as { provider?: string; model?: string };
    if (!body?.provider || !body?.model) {
      return { ok: false, reason: 'provider_and_model_required' };
    }
    const found = fastify.pi.findModel(body.provider, body.model);
    if (!found) return { ok: false, reason: 'model_not_found' };
    return { ok: true, provider: found.provider, id: found.id };
  });
}
