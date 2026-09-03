/**
 * Models routes — surfaces the pi runtime's ModelRegistry.
 *
 * The runtime knows which models are available and which providers have
 * auth configured. The frontend uses this to populate the model selector
 * and the orchestrator's "pick a model" picker.
 */
import { FastifyInstance } from 'fastify';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { AppliedModelCuration } from '../pi/model-curation.js';
import {
  modelCapabilityResolver,
  type ModelCapabilityResolver,
} from '../pi/model-capabilities.js';
import type { ThinkingLevel } from '../pi/thinking.js';
import type { EngineModel } from '../engines/types.js';

type CapabilityResolver = Pick<ModelCapabilityResolver, 'peek' | 'resolve'>;

interface RegisterPiRoutesOptions {
  capabilityResolver?: CapabilityResolver;
}

export function buildModelCatalog(
  fastify: FastifyInstance,
  capabilityResolver: Pick<CapabilityResolver, 'peek'> = modelCapabilityResolver,
) {
  const engines = (fastify as any).engines as { listModels(): EngineModel[] } | undefined;
  const all: EngineModel[] = engines ? engines.listModels() : (fastify.pi.models.getAll() as unknown as EngineModel[]);
  const available: EngineModel[] = engines
    ? all.filter((m) => m.configured !== false)
    : (fastify.pi.models.getAvailable() as unknown as EngineModel[]);
  const configuredKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
  return all.map((m) => {
    const thinkingLevels: ThinkingLevel[] = m.reasoning
      ? (getSupportedThinkingLevels(m as any) as ThinkingLevel[])
      : [];
    return {
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: (m as any).input,
      configured: configuredKeys.has(`${m.provider}/${m.id}`),
      thinkingLevels,
      capabilities: capabilityResolver.peek(m as any),
    };
  });
}

function toModelsResponse(applied: AppliedModelCuration) {
  return {
    allModels: applied.allModels,
    models: applied.models,
    enabledModelKeys: applied.enabledKeys,
    customized: applied.customized,
  };
}

export async function registerPiRoutes(fastify: FastifyInstance, options: RegisterPiRoutesOptions = {}) {
  const capabilityResolver = options.capabilityResolver ?? modelCapabilityResolver;
  fastify.get('/api/models', async () => {
    return toModelsResponse(fastify.modelCuration.apply(buildModelCatalog(fastify, capabilityResolver)));
  });

  fastify.put('/api/models/curation', async (request, reply) => {
    const body = request.body as { enabledModelKeys?: unknown };
    if (!Array.isArray(body.enabledModelKeys)) {
      reply.code(400);
      return { error: 'enabledModelKeys must be an array' };
    }
    const available = buildModelCatalog(fastify, capabilityResolver).filter((m) => m.configured !== false);
    const known = new Set(available.map((m) => `${m.provider}/${m.id}`));
    const enabled = body.enabledModelKeys.filter((key): key is string => typeof key === 'string' && known.has(key));
    fastify.modelCuration.save(enabled);
    return toModelsResponse(fastify.modelCuration.apply(buildModelCatalog(fastify, capabilityResolver)));
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
    // When an engine registry is wired up (production always has one), resolve
    // through it so a hidden model (e.g. Pi's Anthropic OAuth models while the
    // Claude engine owns Anthropic) is treated as not found — falling back to
    // the raw, unfiltered `fastify.pi.models.find` here would defeat the hide.
    const engines = (fastify as any).engines as
      | { resolveModel(key: string): { model: EngineModel } | undefined }
      | undefined;
    const found = engines
      ? engines.resolveModel(`${body.provider}/${body.model}`)?.model
      : fastify.pi.models.find(body.provider, body.model);
    if (!found) return { ok: false, reason: 'model_not_found' };
    const capabilities = await capabilityResolver.resolve(found as any);
    return { ok: true, provider: found.provider, id: found.id, capabilities };
  });
}
