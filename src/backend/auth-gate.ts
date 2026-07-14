/**
 * Bearer-token gate for the main backend.
 *
 * When a token is configured (server.token / NEXUS_BACKEND_TOKEN), every /api/*
 * request except /api/health must present `Authorization: Bearer <token>`. This
 * is what lets the backend be exposed beyond loopback (e.g. over Tailscale) for
 * thin clients. Header-only by design: all frontend REST + streaming uses fetch,
 * which can set headers — so there is no leaky `?token=` query fallback.
 *
 * An empty token is dev-open (no gate), preserving the loopback-only default.
 */
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

/** Constant-time string compare. Guards the length check (timingSafeEqual throws
 *  on length mismatch); token length is not sensitive. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Install the auth gate on `app`. No-op when `token` is empty. Do NOT exempt
 * loopback source IPs: `tailscale serve` proxies remote clients from 127.0.0.1,
 * so an IP-based exemption would let them bypass auth.
 */
export function registerBackendAuth(app: FastifyInstance, token: string): void {
  if (!token) return;
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (path === '/api/health') return;
    const header = request.headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented || !tokenMatches(presented, token)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
