/**
 * Device registration for iOS push (M5). The app posts its APNs token on
 * connect (and after a token change) and deletes it on sign-out. Gated by the
 * backend auth bearer like every other /api/* route.
 */
import { FastifyInstance } from 'fastify';
import { registerDevice, deleteDeviceByToken, type DeviceEnv } from '../devices/index.js';

export async function registerDeviceRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.post('/api/devices', async (request) => {
    const body = request.body as { token?: string; platform?: string; env?: string };
    const token = (body.token ?? '').trim();
    if (!token) {
      const err = new Error('token is required') as any;
      err.statusCode = 400;
      throw err;
    }
    const env: DeviceEnv = body.env === 'production' ? 'production' : 'sandbox';
    const row = registerDevice(db, { token, platform: body.platform, env });
    return { ok: true, device: row };
  });

  fastify.delete('/api/devices/:token', async (request) => {
    const { token } = request.params as { token: string };
    deleteDeviceByToken(db, decodeURIComponent(token));
    return { success: true };
  });
}
