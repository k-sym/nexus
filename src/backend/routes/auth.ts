/**
 * Auth routes — thin transport over the pi runtime's `AuthStorage`.
 *
 * The legacy local auth subsystem (`backend/auth/oauth.ts`,
 * `backend/auth/store.ts`) is gone. Auth is now served by pi's
 * `AuthStorage` at `~/.nexus/auth.json`. We expose REST endpoints that
 * delegate to it, plus a minimal OAuth start/cancel stub for the
 * eventual full PKCE loopback flow (Phase 4 + follow-up).
 */
import { FastifyInstance } from 'fastify';

interface AuthProvider {
  id: string;
  type: 'api_key' | 'oauth';
}

export async function registerAuthRoutes(fastify: FastifyInstance) {
  const auth = fastify.pi.auth;

  fastify.get('/api/auth/has-credentials', async () => {
    const ids = auth.list();
    return { ok: ids.length > 0, providers: ids };
  });

  fastify.get('/api/auth/status', async () => {
    const ids = auth.list();
    const providers: AuthProvider[] = ids.map((id) => {
      const cred = auth.get(id);
      return { id, type: cred?.type ?? 'api_key' };
    });
    return { providers, hasAny: providers.length > 0 };
  });

  fastify.post('/api/auth/save-key', async (request) => {
    const body = request.body as { provider?: string; key?: string };
    if (!body?.provider || !body?.key) {
      return { ok: false, reason: 'provider_and_key_required' };
    }
    auth.set(body.provider, { type: 'api_key', key: body.key });
    return { ok: true };
  });

  fastify.post('/api/auth/logout', async (request) => {
    const body = request.body as { provider?: string };
    if (!body?.provider) return { ok: false, reason: 'provider_required' };
    auth.remove(body.provider);
    return { ok: true };
  });

  // OAuth start/cancel are stubbed. The full PKCE flow needs:
  //   1. `auth.login(providerId, callbacks)` from pi's AuthStorage
  //   2. SSE channel from the route to the React UI for progress
  //      (auth_url, progress, complete, cancelled, error)
  //   3. A `cancel` route that signals an AbortController
  // This is a follow-up commit. The frontend can already call
  // /save-key today; OAuth providers (Anthropic, OpenAI Codex, GitHub
  // Copilot) work via API key in the meantime.
  fastify.post('/api/auth/start-oauth', async (_request, reply) => {
    reply.code(501);
    return { ok: false, reason: 'not_implemented' };
  });
  fastify.post('/api/auth/cancel-oauth', async () => ({ ok: true }));
}
