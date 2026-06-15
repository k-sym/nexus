/**
 * Resolve a GitHub token for issue sync. Prefers `process.env.GITHUB_TOKEN`
 * (checked every call so a newly-set env var takes effect immediately), and
 * otherwise falls back to the `gh` CLI's `gh auth token` — which is how the
 * packaged/"Live" app (launched from Finder, without the repo's .env) gets a
 * token. The CLI result is cached for the process lifetime.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable command runner so token.ts unit tests can supply a fake `gh`. */
export type GhRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const GH_TIMEOUT_MS = 3_000;

/**
 * `gh` lookup candidates, tried in order. GUI/Finder launches inherit a
 * minimal PATH, so bare `gh` may not resolve — fall through to the common
 * Homebrew / system install locations.
 */
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

// Process-lifetime cache of the resolved CLI token: undefined = not yet
// resolved, string = a token, null = the CLI lookup failed (so we don't keep
// shelling out on every Kanban open).
let cachedGhToken: string | null | undefined;

const defaultRunGh: GhRunner = (file, args) => execFileAsync(file, args, { timeout: GH_TIMEOUT_MS });

async function resolveViaGh(runGh: GhRunner): Promise<string | null> {
  for (const candidate of GH_CANDIDATES) {
    try {
      const { stdout } = await runGh(candidate, ['auth', 'token']);
      const token = stdout.trim();
      if (token) return token;
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

export async function resolveGitHubToken(runGh: GhRunner = defaultRunGh): Promise<string | undefined> {
  const fromEnv = process.env.GITHUB_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  if (cachedGhToken === undefined) {
    cachedGhToken = await resolveViaGh(runGh);
  }
  return cachedGhToken ?? undefined;
}

/** Test-only: clear the cached CLI lookup so the next call re-resolves. */
export function __resetTokenCache(): void {
  cachedGhToken = undefined;
}

/** Test-only: prime the cache so callers short-circuit without shelling out. */
export function __primeTokenCache(value: string | null): void {
  cachedGhToken = value;
}
