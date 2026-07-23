/**
 * Docker Compose, as much of it as an agent is allowed to touch.
 *
 * The capability was already reachable before this module existed: Pi ships a
 * `bash` tool and Nexus does not strip it, so a model could always run
 * `docker compose up`. What it could not do was run it *safely* —
 *
 *   - `bash` is foreground-only, so `up` without `-d` blocks the turn until the
 *     tool times out. Here `up` is always detached; there is no way to ask for
 *     the hanging form.
 *   - Compose derives its project name from the directory, so two threads on
 *     one repo silently share and steal each other's containers. Every command
 *     here is pinned to a per-thread project name instead.
 *   - Nothing recorded what was started, so nothing could tear it down. The
 *     project name doubles as the teardown handle: Compose stamps it onto every
 *     container it creates as `com.docker.compose.project`, so the containers a
 *     thread owns are always discoverable from the thread id alone, even after
 *     a backend restart that lost all in-memory state.
 *
 * Commands are spawned with an argv array and no shell, and the verb is chosen
 * from a fixed set — the model supplies a service list and a compose file, never
 * a command line.
 *
 * Part of #264.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep } from 'node:path';

/** Hard ceiling on any docker invocation. `up` pulling a cold image is the slow
 *  case; past this something is wrong and the turn should get an error rather
 *  than wait indefinitely. */
export const DOCKER_TIMEOUT_MS = 10 * 60_000;

/** Probes are quick or they are broken — a hung daemon should not cost minutes
 *  of session-creation time. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Cap on captured output. The signal filter projects tool results down before
 *  they reach the model, but that runs on what we hand it, so an unbounded
 *  `logs` would still have to be buffered in full first. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Default number of log lines returned when the caller doesn't say. */
export const DEFAULT_LOG_TAIL = 100;
export const MAX_LOG_TAIL = 1_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injection seam. Tests substitute this; production spawns a real `docker`. */
export type DockerExec = (args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<ExecResult>;

export const realDockerExec: DockerExec = (args, { cwd, timeoutMs }) =>
  new Promise((resolvePromise) => {
    execFile(
      'docker',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // Never reject: a non-zero exit is a normal, reportable outcome here
        // (no such service, compose file has an error), and the caller wants
        // the stderr text more than it wants an exception.
        const code = typeof (error as { code?: unknown } | null)?.code === 'number'
          ? (error as { code: number }).code
          : error ? 1 : 0;
        resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', code });
      },
    );
  });

export interface DockerAvailability {
  available: boolean;
  /** Why not, when unavailable. Surfaced in logs, never to the model — a
   *  session simply does not advertise a tool it cannot run. */
  reason?: string;
}

/**
 * Is there a Docker daemon we can talk to?
 *
 * `docker info` rather than `docker version`: the latter succeeds when only the
 * CLI is installed, which is exactly the case that would register the tool and
 * then fail on every call.
 */
export async function probeDocker(exec: DockerExec = realDockerExec): Promise<DockerAvailability> {
  try {
    const result = await exec(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (result.code !== 0) {
      return { available: false, reason: result.stderr.trim().split('\n')[0] || 'docker info failed' };
    }
    return { available: true };
  } catch (error) {
    // Most likely ENOENT — no docker binary at all.
    return { available: false, reason: error instanceof Error ? error.message : 'docker unavailable' };
  }
}

/**
 * Compose project name for a thread.
 *
 * This is the isolation boundary AND the teardown handle, so it has to be
 * derived purely from the thread id — reconstructible after a restart, with no
 * stored state to lose. Compose requires `[a-z0-9][a-z0-9_-]*`.
 */
export function composeProjectName(threadId: string): string {
  const slug = threadId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 40);
  return `nexus-${slug || 'default'}`;
}

/** True for project names this module owns — the filter for orphan sweeps. */
export function isNexusProject(name: string): boolean {
  return name.startsWith('nexus-');
}

export class ComposeFileError extends Error {}

/**
 * Resolve the compose file to use, refusing anything outside the thread's cwd.
 *
 * The model chooses this path, and a compose file is executable configuration:
 * it can bind-mount host paths and publish ports. Letting a turn reach
 * `../../other-project/docker-compose.yml` — or an absolute path anywhere on
 * the host — would make "the agent works in this repo" untrue. Symlinks are
 * resolved before the check so a link inside the repo cannot point out of it.
 */
export async function resolveComposeFile(
  cwd: string,
  file: string | undefined,
  realpathFn: (p: string) => Promise<string> = realpath,
): Promise<string | undefined> {
  const candidate = file?.trim();
  // Undefined means "let Compose find it" — its own discovery is rooted at cwd.
  if (!candidate) return undefined;

  if (isAbsolute(candidate)) throw new ComposeFileError('compose_file must be relative to the project directory.');
  const absolute = resolve(cwd, candidate);

  // Resolve the two independently. If the file's realpath fails — it may not
  // exist yet, which is legitimate — fall back to joining against the RESOLVED
  // cwd, not the raw one. Comparing a resolved cwd with an unresolved file path
  // rejects every valid file on macOS, where /var is a symlink to /private/var.
  let realCwd = cwd;
  try {
    realCwd = await realpathFn(cwd);
  } catch {
    /* cwd should exist, but a lexical comparison still catches `../` */
  }
  let realFile: string;
  try {
    realFile = await realpathFn(absolute);
  } catch {
    realFile = resolve(realCwd, candidate);
  }

  const rel = relative(realCwd, realFile);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new ComposeFileError('compose_file must be inside the project directory.');
  }
  return candidate;
}

/** Trim captured output to something a context window can hold. */
export function boundOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Keep the tail: for docker output the interesting part (the error, the last
  // log lines) is at the end.
  let buf = Buffer.from(text, 'utf8').subarray(-maxBytes);
  // A byte-wise cut can land inside a multi-byte character, which decodes to a
  // replacement char. Skip leading UTF-8 continuation bytes (0b10xxxxxx) so the
  // slice starts on a character boundary. Docker output is routinely non-ASCII
  // — compose's own progress uses ✔ and ⠿.
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  buf = buf.subarray(start);

  const truncated = buf.toString('utf8');
  // Drop a partial first line so the model isn't handed half a log entry.
  const firstNewline = truncated.indexOf('\n');
  const clean = firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated;
  return `[earlier output truncated]\n${clean}`;
}

export interface ComposeCommandOptions {
  /** Where Compose runs. Required in practice for `up`/`logs`/`status`, which
   *  need to find a compose file. `down` works without it: Compose reconstructs
   *  the project from container labels, which is what lets the orphan sweep
   *  clean up projects whose repo has since been deleted. */
  cwd?: string;
  projectName: string;
  composeFile?: string;
  exec?: DockerExec;
  timeoutMs?: number;
}

/** Build the argv shared by every compose invocation. */
export function composeArgs(projectName: string, composeFile: string | undefined, rest: string[]): string[] {
  const args = ['compose', '--project-name', projectName];
  if (composeFile) args.push('--file', composeFile);
  return [...args, ...rest];
}

async function runCompose(options: ComposeCommandOptions, rest: string[]): Promise<ExecResult> {
  const exec = options.exec ?? realDockerExec;
  const result = await exec(composeArgs(options.projectName, options.composeFile, rest), {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? DOCKER_TIMEOUT_MS,
  });
  return { ...result, stdout: boundOutput(result.stdout), stderr: boundOutput(result.stderr) };
}

/** Start services, always detached. There is deliberately no non-detached form. */
export function composeUp(options: ComposeCommandOptions, services: string[] = []): Promise<ExecResult> {
  return runCompose(options, ['up', '--detach', ...services]);
}

/** Stop and remove this thread's services, including their volumes' containers.
 *  `--remove-orphans` catches containers left by an earlier compose file. */
export function composeDown(options: ComposeCommandOptions): Promise<ExecResult> {
  return runCompose(options, ['down', '--remove-orphans']);
}

export function composeStatus(options: ComposeCommandOptions): Promise<ExecResult> {
  return runCompose(options, ['ps', '--format', 'json']);
}

export function composeLogs(
  options: ComposeCommandOptions,
  services: string[] = [],
  tail: number = DEFAULT_LOG_TAIL,
): Promise<ExecResult> {
  const bounded = Math.max(1, Math.min(MAX_LOG_TAIL, Math.floor(tail)));
  // `--no-log-prefix` is deliberately NOT passed: with several services the
  // prefix is the only thing saying which one spoke.
  return runCompose(options, ['logs', '--no-color', '--tail', String(bounded), ...services]);
}

/**
 * Compose projects currently running that this module owns.
 *
 * Used to find orphans: containers whose thread is gone (backend restarted, or
 * a session dropped while Docker was unreachable). Reads Compose's own project
 * listing rather than a Nexus-side record, so it is correct even when the
 * record is the thing that was lost.
 */
export async function listNexusProjects(exec: DockerExec = realDockerExec): Promise<string[]> {
  const result = await exec(['compose', 'ls', '--all', '--format', 'json'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (entry && typeof entry === 'object' ? String((entry as { Name?: unknown }).Name ?? '') : ''))
      .filter((name) => name && isNexusProject(name));
  } catch {
    // A docker version whose `compose ls --format json` shape differs is not
    // worth failing a sweep over.
    return [];
  }
}
