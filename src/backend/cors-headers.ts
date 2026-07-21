import type { FastifyRequest } from 'fastify';

/**
 * CORS headers for hijacked / raw responses (e.g. NDJSON streams) that bypass
 * @fastify/cors's normal header injection. Mirrors the global `origin: true`
 * config used by the main backend: reflect the request Origin when present,
 * and Vary on Origin so caches don't pin a reflected value.
 *
 * Regular (non-hijacked) replies get these headers automatically from
 * @fastify/cors; only raw/hijacked replies need them added by hand. This is
 * credentials-free (the API uses Bearer-in-header, no `credentials: 'include'`),
 * so no `Access-Control-Allow-Credentials` header is emitted.
 */
export function corsHeaders(request: FastifyRequest): Record<string, string> {
  const origin = request.headers.origin;
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}
