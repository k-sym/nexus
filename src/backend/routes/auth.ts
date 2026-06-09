/**
 * Auth routes — provider OAuth flow management.
 *
 * Mirrors zosma-cowork's start_oauth/cancel_oauth pattern but exposed as
 * REST endpoints with NDJSON streaming for progress events.
 */
import { FastifyInstance } from 'fastify';
import {
  isProviderOAuthSupported,
  isProviderLoggedIn,
  startOAuth,
  cancelOAuth,
  getInflightProvider,
  type OAuthEvent,
} from '../auth/oauth';
import { loadAuth, providerDisplayName } from '../auth/store';

export async function registerAuthRoutes(fastify: FastifyInstance) {
  /**
   * Auth status across all known providers.
   * Returns: { providers: [{ id, name, oauthSupported, loggedIn }] }
   */
  fastify.get('/api/auth/status', async () => {
    const knownProviders = ['anthropic', 'openai-codex', 'github-copilot'];
    const auth = loadAuth();

    const providers = await Promise.all(knownProviders.map(async id => ({
      id,
      name: providerDisplayName(id),
      oauthSupported: isProviderOAuthSupported(id),
      loggedIn: await isProviderLoggedIn(id),
      hasCredential: id in auth,
      credentialType: auth[id]?.type ?? null,
    })));
    return {
      providers,
      inFlight: getInflightProvider(),
    };
  });

  /**
   * Start an OAuth flow for a provider.
   * Streams NDJSON events (auth_url, progress, complete, cancelled, error).
   * Closes when the flow resolves.
   */
  fastify.post('/api/auth/oauth/start', async (request, reply) => {
    const body = request.body as { providerId?: string };
    const providerId = body.providerId;
    if (!providerId || !isProviderOAuthSupported(providerId)) {
      reply.code(400);
      return { error: 'Unsupported provider' };
    }

    const result = startOAuth(providerId, (ev: OAuthEvent) => {
      try {
        reply.raw.write(JSON.stringify(ev) + '\n');
      } catch { /* client gone */ }
    });

    if (!result.ok) {
      reply.code(400);
      return { error: result.reason || 'Failed to start OAuth' };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    // Don't end the response — the OAuth promise resolves the flow.
    // The flow's emitter writes events; when the flow settles, we close.
  });

  /**
   * Cancel an in-flight OAuth flow.
   */
  fastify.post('/api/auth/oauth/cancel', async () => {
    const result = cancelOAuth();
    return { ok: result.ok };
  });

  /**
   * Clear credentials for a provider.
   */
  fastify.post('/api/auth/logout', async (request) => {
    const body = request.body as { providerId?: string };
    if (!body.providerId) return { error: 'providerId required' };
    const { clearCredential } = await import('../auth/store.js');
    clearCredential(body.providerId);
    return { ok: true };
  });
}
