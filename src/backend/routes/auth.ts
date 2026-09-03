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
import { loadConfig } from '../config.js';
import type { ClaudeEngineConfig } from '../engines/claude/auth.js';

interface AuthProvider {
  id: string;
  type: 'api_key' | 'oauth';
}

const OAUTH_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot']);

export interface RegisterAuthRoutesOptions {
  config?: () => ClaudeEngineConfig;
}

export async function registerAuthRoutes(fastify: FastifyInstance, options: RegisterAuthRoutesOptions = {}) {
  const auth = fastify.pi.auth;
  const config = options.config ?? (() => loadConfig().engines.claude);

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
    // Anthropic through Pi's OAuth bridge is the non-compliant path this
    // engine replaces: while the Claude engine is enabled, subscription login
    // through Pi is refused outright — regardless of whether a credential is
    // already stored — so a new one can never be created either.
    if (body.provider === 'anthropic') {
      let cfg: ClaudeEngineConfig | undefined;
      try {
        cfg = config();
      } catch {
        cfg = undefined;
      }
      if (cfg?.enabled === true) {
        reply.code(400);
        return { ok: false, reason: 'claude_engine_owns_anthropic' };
      }
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
