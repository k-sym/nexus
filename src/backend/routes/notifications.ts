/** Notifications API — unseen list + mark-seen, polled by the frontend toaster. */
import { FastifyInstance } from 'fastify';
import { listUnseen, markSeen } from '../notifications/index.js';

export async function registerNotificationRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/notifications', async () => {
    return listUnseen(db);
  });

  fastify.post('/api/notifications/seen', async (request) => {
    const body = request.body as { ids?: string[] };
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    markSeen(db, ids);
    return { ok: true, seen: ids.length };
  });
}
