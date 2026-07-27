/**
 * Dev-only helpers, registered only when NODE_ENV !== 'production'. Still behind
 * the backend bearer-token gate like every other /api/* route.
 *
 * `POST /api/dev/test-push` fires a push to every registered device so you can
 * verify the notification banner, the deep link, and the app-icon badge without
 * having to trigger a real run or tool gate. The response reports whether APNs
 * is configured and how many devices it targeted, so a "nothing happened" is
 * easy to diagnose.
 */
import { FastifyInstance } from 'fastify';
import { listDevices } from '../devices/index.js';

interface TestPushBody {
  title?: string;
  body?: string;
  /** App-icon badge to set. Defaults to 1 so you can see the badge appear. */
  badge?: number;
  /** Deep link the tap should route to. Defaults to opening the app. */
  deepLink?: string;
}

export async function registerDevRoutes(fastify: FastifyInstance) {
  fastify.post('/api/dev/test-push', async (request) => {
    const b = (request.body ?? {}) as TestPushBody;
    const devices = listDevices(fastify.db);

    const message = {
      title: b.title ?? 'Test notification',
      body: b.body ?? 'Nexus test push — badge, banner and deep link.',
      deepLink: b.deepLink ?? 'open:',
      badge: typeof b.badge === 'number' ? b.badge : 1,
    };

    if (!fastify.apns.configured) {
      return {
        ok: false,
        reason: 'apns_not_configured',
        hint: 'Set apns.enabled with a resolvable .p8 key_id/team_id/bundle_id in config.',
        deviceCount: devices.length,
        sent: message,
      };
    }
    if (devices.length === 0) {
      return {
        ok: false,
        reason: 'no_registered_devices',
        hint: 'Open the iOS app (connected + notifications allowed) so it registers its APNs token.',
        deviceCount: 0,
        sent: message,
      };
    }

    await fastify.apns.notify(message);
    return { ok: true, deviceCount: devices.length, sent: message };
  });
}
