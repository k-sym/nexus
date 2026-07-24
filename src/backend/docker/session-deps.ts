/**
 * Wiring between the backend and the `docker_service` tool.
 *
 * Two jobs: decide whether a session gets the tool at all, and tear a thread's
 * services down when its session is dropped.
 *
 * Mirrors `src/backend/monday/session-deps.ts` — the resolver is called during
 * session creation and returns `null` to omit the tool entirely, so a session
 * never advertises something it cannot run.
 *
 * Part of #264.
 */
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config.js';
import type { DockerToolDeps } from '../pi/docker-tool.js';
import {
  composeDown,
  composeProjectName,
  probeDocker,
  type DockerExec,
} from './compose.js';

/**
 * How long a probe result is trusted.
 *
 * Session creation is synchronous, so it cannot await a probe — it reads the
 * last known answer. A TTL means Docker Desktop started after Nexus is noticed
 * within a minute rather than never, at the cost of a session created in that
 * window not getting the tool. That trade is the right way round: a session
 * without the tool is a small loss, and blocking every session creation on a
 * daemon that may be hung is not.
 */
export const PROBE_TTL_MS = 60_000;

export interface DockerAvailabilityCache {
  /** Last known answer. Starts false so nothing is offered before the first probe. */
  available: boolean;
  checkedAt: number;
  inFlight: boolean;
}

export interface DockerSessionDepsOptions {
  getConfig?: () => NexusConfig;
  exec?: DockerExec;
  now?: () => number;
}

/**
 * Availability tracker: a cached boolean plus a background refresh.
 *
 * Deliberately not a Promise-returning API. Its one caller is synchronous, and
 * making it async would push that constraint into session creation.
 */
export class DockerAvailability {
  private cache: DockerAvailabilityCache = { available: false, checkedAt: 0, inFlight: false };
  private readonly exec?: DockerExec;
  private readonly now: () => number;

  constructor(options: DockerSessionDepsOptions = {}) {
    this.exec = options.exec;
    this.now = options.now ?? Date.now;
  }

  /** Last known answer, kicking off a refresh when it has gone stale. */
  isAvailable(): boolean {
    if (this.now() - this.cache.checkedAt > PROBE_TTL_MS) void this.refresh();
    return this.cache.available;
  }

  /** Probe now. Concurrent calls share one in-flight probe. */
  async refresh(): Promise<boolean> {
    if (this.cache.inFlight) return this.cache.available;
    this.cache.inFlight = true;
    try {
      const result = await probeDocker(this.exec);
      this.cache = { available: result.available, checkedAt: this.now(), inFlight: false };
      return result.available;
    } catch {
      // A probe that throws is an unavailable daemon, not a backend error.
      this.cache = { available: false, checkedAt: this.now(), inFlight: false };
      return false;
    } finally {
      this.cache.inFlight = false;
    }
  }
}

/** Whether the feature is switched on, read live so a config edit takes effect
 *  on the next session rather than the next restart. */
function dockerEnabled(getConfig: () => NexusConfig): boolean {
  try {
    return getConfig().docker?.enabled === true;
  } catch {
    // A config that fails to load must not brick session creation.
    return false;
  }
}

/** Host paths a compose file may bind-mount despite escaping the repo. Read
 *  live and defensively — a bad config yields an empty allowlist (fail closed),
 *  not a crash. */
function allowedHostMounts(getConfig: () => NexusConfig): string[] {
  try {
    const list = getConfig().docker?.allow_host_mounts;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * Build the session resolver. Returns `null` — omitting the tool — when the
 * feature is off or no daemon answered the last probe.
 */
export function buildDockerToolDeps(
  availability: DockerAvailability,
  options: DockerSessionDepsOptions = {},
): (threadId: string, cwd: string) => DockerToolDeps | null {
  const getConfig = options.getConfig ?? loadConfig;
  return (threadId, cwd) => {
    if (!cwd) return null;
    if (!dockerEnabled(getConfig)) return null;
    if (!availability.isAvailable()) return null;
    // Read live so a config edit to the allowlist lands on the next session.
    return { threadId, cwd, exec: options.exec, allowHostMounts: allowedHostMounts(getConfig) };
  };
}

/**
 * Tear down a thread's compose project.
 *
 * Fire-and-forget by design: `dropSession` is synchronous and must not fail, or
 * block, because Docker is unreachable. Anything left behind is still
 * addressable by project name, so a later sweep can finish the job.
 */
export function buildTearDownServices(
  availability: DockerAvailability,
  options: DockerSessionDepsOptions = {},
): (threadId: string, cwd: string) => void {
  return (threadId, cwd) => {
    if (!cwd) return;
    // Note the asymmetry with the resolver: teardown is deliberately NOT gated
    // on `docker.enabled`. Turning the feature off after a thread started
    // containers must not strand them — the flag governs whether an agent may
    // start services, not whether we may clean up after one that did.
    if (!availability.isAvailable()) return;
    const projectName = composeProjectName(threadId);
    void composeDown({ cwd, projectName, exec: options.exec })
      .catch(() => { /* best effort; the sweep is the backstop */ });
  };
}
