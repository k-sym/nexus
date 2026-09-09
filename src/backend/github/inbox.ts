/**
 * The board's GitHub feed (#439): a project's open issues, read live through a
 * per-project cache. Replaces github/sync.ts, which copied issues into Triage
 * tasks so the old board could show them; the session-first board shows them
 * directly in its Inbox and never writes a row.
 *
 * Throttled per project so the board can ask on every open: within the window
 * the last result is returned as-is (a throttled call is never empty-handed
 * once one fetch has succeeded). A fetch failure with a cached result returns
 * the cache plus the error, so the board degrades to "slightly stale" rather
 * than "empty".
 */
import type Database from 'better-sqlite3';
import type { Project } from '@nexus/shared';
import { parseGitHubRepo, detectGitRemote } from './repo.js';
import { fetchOpenIssues, GitHubError, type GitHubIssue, type GitHubRepoRef } from './client.js';
import { resolveGitHubToken } from './token.js';
import type { ActivityEvent } from '../activity/events.js';

const THROTTLE_MS = 3 * 60 * 1000; // at most one network read per project per 3 min

interface CacheEntry {
  at: number;
  issues: GitHubIssue[];
}

const cache = new Map<string, CacheEntry>();

/** Test helper: clear the per-project cache (and with it the throttle). */
export function __resetInboxCache(): void {
  cache.clear();
}

// Last error message we notified about, per project. Suppresses a flood of
// identical "GitHub failed" toasts on every board open (e.g. a private repo
// with no token returning the same 404 each time).
const lastError = new Map<string, string>();

/** Record an error and report whether it differs from the last one notified. */
export function noteSyncError(projectId: string, message: string): boolean {
  if (lastError.get(projectId) === message) return false;
  lastError.set(projectId, message);
  return true;
}

export function clearSyncError(projectId: string): void {
  lastError.delete(projectId);
}

/** Test-only: clear the per-project last-error map. */
export function __resetErrorState(): void {
  lastError.clear();
}

/**
 * Backfill a project's git_remote from its repo_path when it's empty. Projects
 * created before remote-detection existed have an empty git_remote, so they'd
 * never show an Inbox; this detects and persists the remote on first use.
 */
export async function ensureProjectGitRemote(
  db: Database.Database,
  project: Project,
  detect: (repoPath: string) => Promise<string> = detectGitRemote,
): Promise<Project> {
  if (project.git_remote || !project.repo_path) return project;
  const detected = await detect(project.repo_path);
  if (!detected) return project;
  db.prepare('UPDATE projects SET git_remote = ? WHERE id = ?').run(detected, project.id);
  return { ...project, git_remote: detected };
}

export interface InboxIssuesOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  emit?: (event: ActivityEvent) => void;
  /** Bypass the throttle (the board's explicit Refresh). */
  refresh?: boolean;
}

export interface InboxIssuesResult {
  /** The parsed GitHub remote, or null when the project has none. */
  ref: GitHubRepoRef | null;
  issues: GitHubIssue[];
  /** True when the result came from the cache (throttled or after a failure). */
  fromCache: boolean;
  /** The fetch error, when one happened on this call. Null otherwise. */
  error: string | null;
}

/** Open issues for the project. Never throws: a failure with nothing cached
 *  returns an empty list and the error. */
export async function listOpenIssues(
  project: Project,
  opts: InboxIssuesOptions = {},
): Promise<InboxIssuesResult> {
  const now = opts.now ?? (() => Date.now());
  const ref = parseGitHubRepo(project.git_remote || '');
  if (!ref) return { ref: null, issues: [], fromCache: false, error: null };

  const cached = cache.get(project.id);
  if (cached && !opts.refresh && now() - cached.at < THROTTLE_MS) {
    return { ref, issues: cached.issues, fromCache: true, error: null };
  }

  const operationId = crypto.randomUUID();
  const title = `GitHub issues · ${project.name}`;
  opts.emit?.({ type: 'start', operationId, kind: 'github_sync', title, projectId: project.id });
  try {
    const token = opts.token ?? await resolveGitHubToken();
    const issues = await fetchOpenIssues(ref, token, opts.fetchImpl ?? fetch);
    cache.set(project.id, { at: now(), issues });
    opts.emit?.({ type: 'stop', operationId, kind: 'github_sync', title, status: 'succeeded', diagnostics: { total: issues.length } });
    return { ref, issues, fromCache: false, error: null };
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : ((err as Error)?.message ?? 'GitHub request failed');
    opts.emit?.({ type: 'stop', operationId, kind: 'github_sync', title, status: 'failed', error: message });
    // Hold the throttle after a failure too, or a broken token would retry on
    // every 5 s board poll.
    cache.set(project.id, { at: now(), issues: cached?.issues ?? [] });
    return { ref, issues: cached?.issues ?? [], fromCache: true, error: message };
  }
}

/** One issue from the cache, refreshing when the cache is cold. */
export async function findOpenIssue(
  project: Project,
  number: number,
  opts: InboxIssuesOptions = {},
): Promise<GitHubIssue | null> {
  const result = await listOpenIssues(project, opts);
  return result.issues.find((issue) => issue.number === number) ?? null;
}
