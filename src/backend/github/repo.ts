/**
 * Detect and parse the GitHub repository behind a project's local checkout.
 * Detection shells out to `git remote get-url origin` (the codebase already
 * uses execFile elsewhere); parsing tolerates SSH and HTTPS remote forms and
 * only recognises github.com.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable runner so tests don't shell out. Mirrors execFileAsync's shape. */
export type GitRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRun: GitRunner = (file, args) => execFileAsync(file, args, { timeout: 5_000 });

/**
 * Return the origin remote URL for a local repo, or '' if the path isn't a git
 * repo, has no origin, or git fails for any reason. Never throws.
 */
export async function detectGitRemote(repoPath: string, run: GitRunner = defaultRun): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Parse `owner`/`repo` out of a GitHub remote URL. Returns null for non-GitHub
 * hosts or unparseable input.
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo(.git)
 */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const trimmed = url.trim();
  // SSH: git@github.com:owner/repo(.git)
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // HTTPS (or git+https / ssh://...): host must be github.com
  const https = /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}
