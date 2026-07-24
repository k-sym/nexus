/**
 * Read-only view of a thread's agent browser (#283 Phase 3).
 *
 * The agent's browser is headless, so the model sees the page and the human
 * never does. This surfaces the current viewport as a JPEG the UI polls, so a
 * developer can watch a reproduction or a verification happen — and, in
 * thin-client mode, see what the browser running on baker-pro is doing, which
 * is otherwise the one thing they have no window onto.
 *
 * The image comes back base64 in the JSON body (not as an `<img>`-loadable URL)
 * on purpose: over Tailscale the backend gates `/api/*` behind a bearer, and an
 * `<img src>` can't carry it — the panel fetches this through the same
 * authenticated path as every other call.
 *
 * There is no capture endpoint that *launches* a browser: `view` peeks an
 * already-open page and returns null otherwise, so polling this never spins one
 * up. Only an agent navigation opens a browser.
 */
import type { FastifyInstance } from 'fastify';
import type { BrowserView } from '../browser/page.js';

export interface BrowserRouteOptions {
  /** Whether the browser feature is on and a browser binary exists. Defaults to
   *  off, so a backend built without browser support reports unavailable rather
   *  than erroring. */
  enabled?: () => boolean;
  /** The thread's current preview, or null when it has no browser open. */
  view?: (threadId: string) => Promise<BrowserView | null>;
}

export async function registerBrowserRoutes(fastify: FastifyInstance, options: BrowserRouteOptions = {}): Promise<void> {
  const enabled = options.enabled ?? (() => false);
  const view = options.view ?? (async () => null);

  fastify.get('/api/browser/view', async (request) => {
    if (!enabled()) return { available: false, present: false };

    const query = request.query as { thread?: string; known?: string } | undefined;
    const thread = query?.thread?.trim();
    if (!thread) return { available: true, present: false };

    let snapshot: BrowserView | null;
    try {
      snapshot = await view(thread);
    } catch {
      // A capture that blows up shouldn't 500 the panel — treat it as "nothing
      // to show yet"; the next poll tries again.
      return { available: true, present: false };
    }
    if (!snapshot) return { available: true, present: false };

    // `?known=<version>` lets the client skip re-downloading a frame it already
    // has: an unchanged static page holds its version, so this returns just the
    // version and no image bytes.
    const known = query?.known !== undefined ? Number(query.known) : undefined;
    if (known !== undefined && Number.isFinite(known) && known === snapshot.version) {
      return { available: true, present: true, unchanged: true, version: snapshot.version };
    }

    return { available: true, present: true, view: snapshot };
  });
}
