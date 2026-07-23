/**
 * A minimal Chrome DevTools Protocol client.
 *
 * ## Why not puppeteer-core
 *
 * #265 originally leaned that way. On implementing it, the repo's dependency
 * audit changed the calculation: it runs at `--level=moderate` over production
 * *and* development trees, and `.audit-allowlist.json` states that an entry
 * belongs there only when the fix is genuinely not ours to make. puppeteer-core
 * brings @puppeteer/browsers, chromium-bidi, devtools-protocol,
 * webdriver-bidi-protocol and their own trees — a large permanent audit surface
 * for a feature whose Phase 1 needs four CDP domains.
 *
 * What it needs instead is a WebSocket. `ws` was already in the tree (deduped,
 * via pi-ai's dependencies and @fastify/websocket) and has zero dependencies of
 * its own, so declaring it directly added no package to node_modules. Node's
 * own global `WebSocket` would have been zero-dependency too, but it is only
 * unflagged from 22.4 and this repo's engines floor is >=20.19.0 — it would
 * have broken silently on Node 20.
 *
 * The trade is real: navigation lifecycle and page semantics are ours to get
 * right rather than borrowed. Phase 1's surface (navigate, read, diagnostics)
 * is the part of that where the protocol is simple and the behaviour is easy to
 * verify against a real browser. Phase 2's interaction work is where this
 * decision deserves revisiting.
 *
 * Part of #265.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

/** How long to wait for the browser to print its DevTools endpoint. */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** How long any single CDP command may take before it is abandoned. */
export const COMMAND_TIMEOUT_MS = 30_000;

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type PendingCommand = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpError extends Error {}

/**
 * Flags the browser is launched with.
 *
 * `--user-data-dir` pointing at a fresh temp directory is the important one:
 * the agent's browser must never touch the user's real profile, cookies, or
 * saved credentials. Everything else trims startup behaviour that would either
 * slow launch or phone home.
 */
export function launchFlags(userDataDir: string, port = 0): string[] {
  return [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--mute-audio',
    // Deliberately NOT --no-sandbox: the sandbox is the thing standing between
    // a hostile page and the host, and this browser loads pages we did not write.
    'about:blank',
  ];
}

/**
 * Remove the ephemeral profile directory, tolerating the teardown race.
 *
 * A browser's main process exits promptly, but its child processes (renderer,
 * GPU, zygote) can still be flushing into the profile when we start deleting it
 * — so a plain recursive remove intermittently hits `ENOTEMPTY` as Chrome
 * writes a file into a directory between our unlink of its contents and our
 * rmdir of it. Observed on CI, not locally, which is exactly how a filesystem-
 * timing race shows up.
 *
 * `rmSync`'s own `maxRetries`/`retryDelay` retries precisely this class of error
 * (ENOTEMPTY/EBUSY/EPERM/…) with a linear backoff, which covers the short window
 * while the children finish exiting. Best-effort: a profile we ultimately can't
 * delete is a stray temp directory, never a reason to fail a close.
 */
function removeProfileDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp profile is not worth throwing over */
  }
}

/** Pull the endpoint out of the browser's startup chatter. */
export function parseDevToolsUrl(line: string): string | null {
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
  return match ? match[1] : null;
}

export interface CdpConnectionOptions {
  binaryPath: string;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * One browser process plus its protocol connection.
 *
 * Commands are multiplexed over a single socket by integer id; events are
 * fanned out to subscribers. Sessions are "flat" (`Target.attachToTarget` with
 * `flatten: true`), so page commands carry a `sessionId` on the same socket
 * rather than needing a second connection.
 */
export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly child: ChildProcess,
    private readonly userDataDir: string,
    private readonly commandTimeoutMs: number,
  ) {
    socket.on('message', (data) => this.onMessage(String(data)));
    // A socket that dies takes every in-flight command with it; otherwise a
    // caller waits out the full command timeout for an answer that can't come.
    socket.on('close', () => this.failAll(new CdpError('Browser connection closed.')));
    socket.on('error', (error) => this.failAll(new CdpError(`Browser connection error: ${error.message}`)));
    child.on('exit', () => this.failAll(new CdpError('Browser process exited.')));
  }

  static async launch(options: CdpConnectionOptions): Promise<CdpConnection> {
    // Ephemeral profile, removed on close. Never the user's.
    const userDataDir = mkdtempSync(join(tmpdir(), 'nexus-browser-'));
    const child = spawn(options.binaryPath, launchFlags(userDataDir), { stdio: ['ignore', 'ignore', 'pipe'] });

    let wsUrl: string;
    try {
      wsUrl = await waitForDevToolsUrl(child, options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
    } catch (error) {
      child.kill('SIGKILL');
      removeProfileDir(userDataDir);
      throw error;
    }

    const socket = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', (error) => reject(new CdpError(`Could not connect to the browser: ${error.message}`)));
      });
    } catch (error) {
      child.kill('SIGKILL');
      removeProfileDir(userDataDir);
      throw error;
    }

    return new CdpConnection(socket, child, userDataDir, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
  }

  /** Send a command and await its result. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CdpError('Browser is closed.'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${this.commandTimeoutMs}ms.`));
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(payload);
      } catch (error) {
        this.settle(id);
        reject(new CdpError(`Could not send ${method}: ${(error as Error).message}`));
      }
    });
  }

  /** Subscribe to protocol events. Returns an unsubscribe function. */
  on(handler: (event: CdpEvent) => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new CdpError('Browser is closing.'));
    try { this.socket.close(); } catch { /* already gone */ }
    // Ask politely, then insist. A wedged renderer must not leave a process
    // behind holding the temp profile open.
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 2_000);
      timer.unref?.();
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    removeProfileDir(this.userDataDir);
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // Not something we can act on.
    }

    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id !== undefined) {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.settle(id);
      const error = message.error as { message?: string } | undefined;
      if (error) entry.reject(new CdpError(error.message ?? 'CDP command failed.'));
      else entry.resolve((message.result as Record<string, unknown>) ?? {});
      return;
    }

    if (typeof message.method === 'string') {
      const event: CdpEvent = {
        method: message.method,
        params: (message.params as Record<string, unknown>) ?? {},
        sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
      };
      for (const listener of this.listeners) {
        // A misbehaving subscriber must not break protocol dispatch.
        try { listener(event); } catch { /* ignore */ }
      }
    }
  }

  private settle(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.settle(id);
      entry.reject(error);
    }
  }
}

/** Watch stderr for the DevTools endpoint the browser prints on startup. */
function waitForDevToolsUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new CdpError(`Browser did not report a DevTools endpoint within ${timeoutMs}ms.`))),
      timeoutMs,
    );
    timer.unref?.();

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const url = parseDevToolsUrl(buffer);
      if (url) finish(() => resolve(url));
    };

    child.stderr?.on('data', onData);
    child.once('error', (error) => finish(() => reject(new CdpError(`Could not start the browser: ${error.message}`))));
    child.once('exit', (code) => finish(() => reject(new CdpError(`Browser exited before starting (code ${code}).`))));
  });
}
