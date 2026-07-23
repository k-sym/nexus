/**
 * `POST /api/next-message` — given the tail of a conversation, return the user's
 * likely next message for the composer to offer as a placeholder.
 *
 * Stateless on purpose: the caller passes the transcript it already holds, so
 * this route serves chat, the Assistant, and the glasses cockpit identically
 * with no per-surface code. See
 * `project_docs/design/2026-07-22-next-message-suggestion-design.md`.
 *
 * 400 on a malformed body is the only error status. A daemon that is down or a
 * model that fails returns `{ suggestion: '' }`, because the caller's behaviour
 * is the same either way: show no placeholder.
 */
import type { FastifyInstance } from 'fastify';
import { parseTranscript, suggestNextMessage } from '../sessions/next-message.js';

export async function registerNextMessageRoutes(fastify: FastifyInstance) {
  fastify.post('/api/next-message', async (request, reply) => {
    const turns = parseTranscript((request.body as { transcript?: unknown } | undefined)?.transcript);
    if (!turns) {
      reply.code(400);
      return { error: 'transcript must be an array of { role, text }' };
    }
    return { suggestion: await suggestNextMessage(turns) };
  });
}
