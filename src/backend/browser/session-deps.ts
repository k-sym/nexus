/**
 * Per-thread browser lifecycle.
 *
 * One browser process per thread, launched lazily on first navigation and torn
 * down with the session. Lazy because a browser is expensive and most sessions
 * never open one; per-thread because "read the page I just loaded" requires the
 * page to still be there between tool calls.
 *
 * Mirrors `docker/session-deps.ts`: the resolver returns `null` to omit the
 * tools entirely, so a session never advertises a browser it cannot launch.
 *
 * Part of #265.
 */
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config.js';
import type { BrowserToolDeps } from '../pi/browser-tool.js';
import { CdpConnection } from './cdp.js';
import { findBrowser, type BrowserBinary } from './discover.js';
import { BrowserPage, type BrowserView } from './page.js';

/** Hard cap on concurrent browsers, whatever the thread count. Each is a real
 *  Chromium: a runaway would take the machine down with it. */
export const MAX_CONCURRENT_BROWSERS = 4;

interface ThreadBrowser {
  connection: CdpConnection;
  page: BrowserPage;
}

function browserConfig(getConfig: () => NexusConfig): { enabled: boolean; allowedHosts: string[] } {
  try {
    const browser = getConfig().browser;
    return {
      enabled: browser?.enabled === true,
      allowedHosts: Array.isArray(browser?.allow_hosts) ? browser.allow_hosts : [],
    };
  } catch {
    // A config that fails to load must not brick session creation.
    return { enabled: false, allowedHosts: [] };
  }
}

/**
 * Owns every thread's browser.
 *
 * One instance per backend, so the concurrency cap is global rather than
 * per-session, and so shutdown has something to close.
 */
export class BrowserPool {
  private readonly browsers = new Map<string, ThreadBrowser>();
  /** In-flight launches, so two tool calls racing in one thread share a browser
   *  rather than starting two and leaking one. */
  private readonly launching = new Map<string, Promise<ThreadBrowser>>();

  constructor(private readonly binary: BrowserBinary) {}

  size(): number {
    return this.browsers.size;
  }

  /** The thread's page if a browser is already open, else undefined. Never
   *  launches one — the human-facing view must not spin up a browser just
   *  because a panel polled it; only an agent navigation does that. */
  peek(threadId: string): BrowserPage | undefined {
    return this.browsers.get(threadId)?.page;
  }

  async pageFor(threadId: string): Promise<BrowserPage> {
    const existing = this.browsers.get(threadId);
    if (existing) return existing.page;

    const pending = this.launching.get(threadId);
    if (pending) return (await pending).page;

    if (this.browsers.size >= MAX_CONCURRENT_BROWSERS) {
      throw new Error(
        `Too many browsers already open (${MAX_CONCURRENT_BROWSERS}). Close one by ending another session first.`,
      );
    }

    const launch = this.launch();
    this.launching.set(threadId, launch);
    try {
      const browser = await launch;
      this.browsers.set(threadId, browser);
      return browser.page;
    } finally {
      this.launching.delete(threadId);
    }
  }

  private async launch(): Promise<ThreadBrowser> {
    const connection = await CdpConnection.launch({ binaryPath: this.binary.path });
    try {
      const page = await BrowserPage.create(connection);
      return { connection, page };
    } catch (error) {
      // A half-open browser is a leaked process; close it before rethrowing.
      await connection.close().catch(() => {});
      throw error;
    }
  }

  /** Close a thread's browser. Safe to call for a thread that never had one. */
  async close(threadId: string): Promise<void> {
    const browser = this.browsers.get(threadId);
    this.browsers.delete(threadId);
    if (browser) await browser.connection.close().catch(() => {});
    // A launch in flight would otherwise land in the map after the close and
    // outlive the session it belonged to.
    const pending = this.launching.get(threadId);
    if (pending) {
      this.launching.delete(threadId);
      await pending.then((b) => b.connection.close()).catch(() => {});
      this.browsers.delete(threadId);
    }
  }

  /** Close everything. For backend shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.browsers.keys()].map((id) => this.close(id)));
  }
}

export interface BrowserSessionOptions {
  getConfig?: () => NexusConfig;
  /** Injection seam for tests; production discovers a system browser. */
  findBrowserBinary?: () => BrowserBinary | null;
}

/**
 * Build the pool and the session resolver, or `null` when the feature is off or
 * the machine has no browser to drive.
 *
 * The binary is located once at startup rather than per session: a browser does
 * not appear and disappear the way a Docker daemon does, and probing on every
 * session creation would cost filesystem stats for no benefit.
 */
export interface BrowserSupport {
  pool: BrowserPool;
  browserTools: (threadId: string, cwd: string) => BrowserToolDeps | null;
  closeBrowser: (threadId: string) => void;
  /** Whether the browser feature is on right now (read live). The binary is
   *  known to exist — this object is null otherwise. Used by the view route to
   *  report availability to the panel. */
  isEnabled: () => boolean;
  /** A live preview of the thread's page, or null when the thread has no
   *  browser open (or the feature is off). Peeks — never launches. */
  viewFor: (threadId: string) => Promise<BrowserView | null>;
}

export function createBrowserSupport(options: BrowserSessionOptions = {}): BrowserSupport | null {
  const getConfig = options.getConfig ?? loadConfig;
  const find = options.findBrowserBinary ?? (() => findBrowser());

  const binary = find();
  if (!binary) return null;

  const pool = new BrowserPool(binary);

  return {
    pool,
    browserTools: (threadId) => {
      // Read live, so enabling the feature takes effect on the next session
      // rather than the next restart.
      const config = browserConfig(getConfig);
      if (!config.enabled) return null;
      return {
        getPage: () => pool.pageFor(threadId),
        // Re-read per call: widening allow_hosts should not require a restart,
        // and narrowing it must take effect immediately.
        allowedHosts: () => browserConfig(getConfig).allowedHosts,
      };
    },
    isEnabled: () => browserConfig(getConfig).enabled,
    viewFor: async (threadId) => {
      // Off ⇒ no view, even if a browser happens to still be open from before
      // the feature was disabled: the panel should match the tools.
      if (!browserConfig(getConfig).enabled) return null;
      const page = pool.peek(threadId);
      if (!page) return null;
      return page.captureView();
    },
    // Fire-and-forget: dropSession is synchronous and must not fail, or block,
    // because a browser is being stubborn about exiting.
    closeBrowser: (threadId) => { void pool.close(threadId); },
  };
}
