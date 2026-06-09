/**
 * Models routes — surfaces the pi runtime's ModelRegistry.
 *
 * The runtime knows which models are available and which providers have
 * auth configured. The frontend uses this to populate the model selector
 * and the orchestrator's "pick a model" picker.
 */
import { FastifyInstance } from 'fastify';

export async function registerPiRoutes(fastify: FastifyInstance) {
  fastify.get('/api/models', async () => {
    const all = fastify.pi.models.getAll();
    const available = fastify.pi.models.getAvailable();
    const configuredKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
    const models = all.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      configured: configuredKeys.has(`${m.provider}/${m.id}`),
    }));
    return { models };
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
