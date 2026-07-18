/**
 * Auth routes — thin transport over pi's unified `ModelRuntime`.
 *
 * The legacy local auth subsystem (`backend/auth/oauth.ts`,
 * `backend/auth/store.ts`) is gone. Auth is now served by pi's
 * credential store at `~/.nexus/auth.json`. OAuth flows are wrapped in an
 * in-memory flow manager so the React UI can poll progress and provide
 * manual callback input when a provider asks for it.
 */
import { FastifyInstance } from 'fastify';
import { buildModelCatalog } from './pi.js';

interface AuthProvider {
  id: string;
  type: 'api_key' | 'oauth';
}

const OAUTH_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot']);

export async function registerAuthRoutes(fastify: FastifyInstance) {
  const auth = fastify.pi.auth;

  fastify.get('/api/auth/has-credentials', async () => {
    const ids = (await auth.listCredentials()).map((credential) => credential.providerId);
    return { ok: ids.length > 0, providers: ids };
  });

  fastify.get('/api/auth/status', async () => {
    const providers: AuthProvider[] = (await auth.listCredentials()).map((credential) => ({
      id: credential.providerId,
      type: credential.type,
    }));
    return { providers, hasAny: providers.length > 0 };
  });

  fastify.post('/api/auth/save-key', async (request) => {
    const body = request.body as { provider?: string; key?: string };
    if (!body?.provider || !body?.key) {
      return { ok: false, reason: 'provider_and_key_required' };
    }
    await auth.login(body.provider, 'api_key', {
      prompt: async () => body.key!,
      notify: () => {},
    });
    return { ok: true };
  });

  fastify.post('/api/auth/logout', async (request) => {
    const body = request.body as { provider?: string };
    if (!body?.provider) return { ok: false, reason: 'provider_required' };
    await auth.logout(body.provider);
    return { ok: true };
  });

  fastify.post('/api/auth/start-oauth', async (request, reply) => {
    const body = request.body as { provider?: string };
    if (!body?.provider || !OAUTH_PROVIDERS.has(body.provider)) {
      reply.code(400);
      return { ok: false, reason: 'unsupported_provider' };
    }
    const flow = fastify.oauthFlows.start(body.provider);
    return { ok: true, flowId: flow.id };
  });

  fastify.get('/api/auth/oauth/:flowId', async (request, reply) => {
    const { flowId } = request.params as { flowId: string };
    const status = fastify.oauthFlows.status(flowId);
    if (!status) {
      reply.code(404);
      return { error: 'OAuth flow not found' };
    }
    if (status.state === 'complete') {
      await fastify.pi.models.refresh();
      fastify.modelCuration.markOAuthProviderSynced(status.provider, buildModelCatalog(fastify));
    }
    return status;
  });

  fastify.post('/api/auth/oauth/:flowId/respond', async (request, reply) => {
    const { flowId } = request.params as { flowId: string };
    const body = request.body as { value?: string };
    if (typeof body?.value !== 'string') {
      reply.code(400);
      return { ok: false, reason: 'value_required' };
    }
    return { ok: fastify.oauthFlows.respond(flowId, body.value) };
  });

  fastify.post('/api/auth/cancel-oauth', async (request) => {
    const body = request.body as { flowId?: string };
    return { ok: body?.flowId ? fastify.oauthFlows.cancel(body.flowId) : false };
  });
}
