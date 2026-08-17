/**
 * Process supervision for the backend.
 *
 * The backend runs under launchd with KeepAlive, which restarts the service
 * only when the process *exits*. Three times (2026-08-13, 2026-08-16,
 * 2026-08-18) the process stayed alive while its :4173 listener vanished —
 * `lsof` showed no listening socket for the pid, /api/health refused the
 * connection, and nothing was ever logged. KeepAlive therefore never fired and
 * the outage was silent until a human noticed the iOS app had gone dead.
 *
 * The mechanism was never pinned down; see
 * project_docs/design/2026-08-17-backend-listener-wedge.md for what was ruled
 * out. So this module is deliberately not a targeted fix. It is a floor: make
 * the process notice that it has stopped serving, say so, and exit non-zero so
 * launchd can do the one thing it is good at. Loud beats wedged.
 *
 * Everything here takes its side effects (probe, exit, clock) as parameters so
 * the behaviour can be tested without real timers, sockets or a real exit.
 */
import { request as httpRequest } from 'node:http';

/** ISO-stamped stdout line. The launchd log has no timestamps of its own,
 *  which is why the three incidents could never be correlated with anything. */
export function logInfo(scope: string, message: string): void {
  console.log(`${new Date().toISOString()} [${scope}] ${message}`);
}

/** ISO-stamped stderr line, with the error's stack when there is one. */
export function logError(scope: string, message: string, error?: unknown): void {
  const detail = error instanceof Error
    ? (error.stack ?? `${error.name}: ${error.message}`)
    : error === undefined ? '' : String(error);
  console.error(`${new Date().toISOString()} [${scope}] ${message}${detail ? `\n${detail}` : ''}`);
}

type Exit = (code: number) => void;

const realExit: Exit = (code) => process.exit(code);

/**
 * Log-and-die handlers for the two ways a Node process fails fatally.
 *
 * Node already terminates on both by default; the value here is the timestamped
 * line naming what happened, since the backend's Fastify logger is disabled and
 * a bare default crash lands in the launchd log with no context around it.
 */
export function installProcessGuards(exit: Exit = realExit): void {
  process.on('uncaughtException', (error, origin) => {
    logError('fatal', `uncaughtException (${origin}) — exiting so launchd restarts us`, error);
    exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logError('fatal', 'unhandledRejection — exiting so launchd restarts us', reason);
    exit(1);
  });
}

export interface ShutdownOptions {
  /** Best-effort cleanup (closing headless browsers, mainly). */
  cleanup: () => Promise<void>;
  /** How long cleanup gets before we exit anyway. */
  graceMs?: number;
  signals?: NodeJS.Signals[];
  exit?: Exit;
}

export interface ShutdownHandle {
  /** True once a signal has started an orderly shutdown. The server-close
   *  watcher reads it so a deliberate stop is not reported as the wedge. */
  isShuttingDown: () => boolean;
}

/**
 * Signal handlers that always terminate, even when cleanup does not.
 *
 * The previous handler awaited `browserPool.closeAll()` with no bound, so a
 * browser that would not close left a process that ignored SIGTERM forever —
 * which is why `launchctl kickstart -k` appeared to no-op against a wedged
 * backend and only bootout/bootstrap recovered it. Cleanup now races a timer,
 * and a second signal exits immediately.
 */
export function installShutdownHandlers(options: ShutdownOptions): ShutdownHandle {
  const { cleanup, graceMs = 3_000, signals = ['SIGINT', 'SIGTERM'] as NodeJS.Signals[], exit = realExit } = options;
  let shuttingDown = false;

  for (const signal of signals) {
    process.on(signal, () => {
      if (shuttingDown) {
        logError('shutdown', `second ${signal} while shutting down — exiting now`);
        exit(1);
        return;
      }
      shuttingDown = true;
      logInfo('shutdown', `${signal} received — cleaning up (${graceMs}ms grace)`);

      let done = false;
      const finish = (note: string) => {
        if (done) return;
        done = true;
        logInfo('shutdown', note);
        exit(0);
      };

      const timer = setTimeout(() => finish(`cleanup did not finish in ${graceMs}ms — exiting anyway`), graceMs);
      timer.unref?.();

      void cleanup()
        .then(() => { clearTimeout(timer); finish('cleanup complete'); })
        .catch((error) => {
          clearTimeout(timer);
          logError('shutdown', 'cleanup failed — exiting anyway', error);
          finish('exiting after failed cleanup');
        });
    });
  }

  return { isShuttingDown: () => shuttingDown };
}

export interface HealthProbeOptions {
  port: number;
  host?: string;
  path?: string;
  timeoutMs?: number;
}

/**
 * A probe that answers "is my own listener still accepting connections?".
 *
 * Deliberately a real TCP connection rather than an in-process check: the whole
 * failure being guarded against is one where the process is healthy and only
 * the socket is gone, which nothing in-process can see. `/api/health` is exempt
 * from the bearer gate, so no token is needed.
 */
export function createHealthProbe(options: HealthProbeOptions): () => Promise<boolean> {
  const { port, host = '127.0.0.1', path = '/api/health', timeoutMs = 5_000 } = options;
  return () => new Promise<boolean>((resolve) => {
    // agent: false — the probe must not park a pooled keep-alive socket on the
    // server it is watching, and each probe should prove a fresh connect.
    const req = httpRequest({ host, port, path, method: 'GET', timeout: timeoutMs, agent: false }, (res) => {
      // Any answer proves the listener is there; the status only has to rule
      // out a server that is up but broken.
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

export interface ListenerWatchdogOptions {
  probe: () => Promise<boolean>;
  /** Consecutive failures before the listener is judged gone. */
  threshold?: number;
  intervalMs?: number;
  /** Called once when the listener is judged gone. */
  onDead: (reason: string) => void;
}

export interface ListenerWatchdog {
  /** Run a single probe. Exposed so tests drive the watchdog without timers. */
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
  /** Consecutive failures so far. */
  failures: () => number;
}

/**
 * Polls the process's own listener and reports when it stops answering.
 *
 * A threshold rather than a single failure because the probe competes with real
 * traffic: one refused connection under load is noise, several in a row is the
 * wedge. It fires at most once — the caller's job is to exit, and a second
 * report during that exit would only muddy the log.
 */
export function createListenerWatchdog(options: ListenerWatchdogOptions): ListenerWatchdog {
  const { probe, threshold = 3, intervalMs = 30_000, onDead } = options;
  let failures = 0;
  let fired = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    // A probe that outlives its interval must not stack up behind itself.
    if (fired || inFlight) return;
    inFlight = true;
    try {
      const ok = await probe();
      if (ok) {
        if (failures > 0) logInfo('watchdog', `listener answered again after ${failures} failed probe(s)`);
        failures = 0;
        return;
      }
      failures += 1;
      logError('watchdog', `self-probe failed (${failures}/${threshold})`);
      if (failures >= threshold) {
        fired = true;
        onDead(`listener stopped answering ${threshold} consecutive probes`);
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      // Never the reason the process stays alive.
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    failures: () => failures,
  };
}

/**
 * Report an unexpected `close` on the listening socket.
 *
 * Cheaper and faster than waiting for the watchdog, and it catches the case
 * where something closes the server through Node rather than out from under it.
 * (An fd closed behind libuv's back emits nothing — hence the watchdog too.)
 */
export function watchServerClose(
  server: { on: (event: 'close', listener: () => void) => unknown },
  onUnexpectedClose: (reason: string) => void,
  isDeliberate: () => boolean = () => false,
): void {
  server.on('close', () => {
    if (isDeliberate()) return;
    onUnexpectedClose('the HTTP server emitted "close" without a shutdown being requested');
  });
}
