/**
 * Sync a project's open GitHub issues into Triage tasks. Throttled per project
 * so it's cheap to call on every Kanban navigation, and deduped by
 * (external_source, external_id) so re-syncs never duplicate or disturb a task
 * once it exists — regardless of which column it has been moved to.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Project, TaskPriority } from '@nexus/shared';
import { parseGitHubRepo, detectGitRemote } from './repo.js';
import { fetchOpenIssues } from './client.js';
import { resolveGitHubToken } from './token.js';
import { ActivityEvent } from '../activity/events.js';

const THROTTLE_MS = 3 * 60 * 1000; // at most one network sync per project per 3 min
const lastSyncAt = new Map<string, number>();

/** Test helper: clear the in-memory throttle between cases. */
export function __resetThrottle(): void {
  lastSyncAt.clear();
}

// Last sync-error message we notified about, per project. Used to suppress a
// flood of identical "GitHub sync failed" toasts on every Kanban open (e.g. a
// private repo with no token returning the same 404 each time).
const lastSyncError = new Map<string, string>();

/**
 * Record a sync error and report whether it's worth notifying about: returns
 * true (and stores the message) when it differs from the last error for this
 * project, false when it's identical to the last one we already notified about.
 */
export function noteSyncError(projectId: string, message: string): boolean {
  if (lastSyncError.get(projectId) === message) return false;
  lastSyncError.set(projectId, message);
  return true;
}

/**
 * Forget a project's last sync error. Call on a successful sync so a later
 * failure notifies again instead of being deduped against a stale message.
 */
export function clearSyncError(projectId: string): void {
  lastSyncError.delete(projectId);
}

/** Test-only: clear the per-project last-error map. */
export function __resetErrorState(): void {
  lastSyncError.clear();
}

/**
 * Backfill a project's git_remote from its repo_path when it's empty. Projects
 * created before remote-detection existed have an empty git_remote, so they'd
 * never sync; this detects and persists the remote on first sync. Detection is
 * injectable for tests. Returns the (possibly updated) project.
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

export interface SyncResult {
  created: number;
  total: number;
  /** True when the call returned early because of the throttle window. */
  skippedThrottle: boolean;
}

export interface SyncOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  emit?: (event: ActivityEvent) => void;
}

/**
 * Derive a task priority from an issue's label names. Case-insensitive and
 * first-match-wins over the whole label set, checked from highest tier down:
 * 'urgent'/'critical'/'p0' -> urgent; 'high'/'p1' -> high;
 * 'low'/'p3'/'trivial' -> low; otherwise 'medium'.
 */
export function priorityFromLabels(labels: string[]): TaskPriority {
  const names = labels.map((l) => l.toLowerCase());
  const has = (...keys: string[]) => names.some((n) => keys.some((k) => n.includes(k)));
  if (has('urgent', 'critical', 'p0')) return 'urgent';
  if (has('high', 'p1')) return 'high';
  if (has('low', 'p3', 'trivial')) return 'low';
  return 'medium';
}

/** Build a task body that records the source issue and a short excerpt. */
function issueBody(number: number, url: string, body: string | null): string {
  const excerpt = (body ?? '').trim().slice(0, 500);
  return `From GitHub #${number} (${url})${excerpt ? `\n\n${excerpt}` : ''}`;
}

export async function syncGitHubIssues(
  db: Database.Database,
  project: Project,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const emit = opts.emit;
  const operationId = crypto.randomUUID();

  const ref = parseGitHubRepo(project.git_remote || '');
  if (!ref) return { created: 0, total: 0, skippedThrottle: false };

  emit?.({
    type: 'start',
    operationId,
    kind: 'github_sync',
    title: `GitHub sync · ${project.name}`,
    projectId: project.id,
  });

  const last = lastSyncAt.get(project.id);
  if (last !== undefined && now() - last < THROTTLE_MS) {
    emit?.({
      type: 'stop',
      operationId,
      kind: 'github_sync',
      title: `GitHub sync · ${project.name}`,
      status: 'succeeded',
      diagnostics: { skippedThrottle: true },
    });
    return { created: 0, total: 0, skippedThrottle: true };
  }
  lastSyncAt.set(project.id, now());

  try {
    const token = opts.token ?? await resolveGitHubToken();
    const issues = await fetchOpenIssues(ref, token, fetchImpl);

  const existing = db.prepare(
    "SELECT 1 FROM tasks WHERE project_id = ? AND external_source = 'github' AND external_id = ?",
  );
  const insert = db.prepare(
    'INSERT INTO tasks (id, project_id, title, description, status, priority, external_source, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  let created = 0;
  const insertNew = db.transaction((list: typeof issues) => {
    for (const issue of list) {
      const externalId = String(issue.number);
      if (existing.get(project.id, externalId)) continue;
      const ts = new Date().toISOString();
      insert.run(
        uuid(), project.id,
        `[#${issue.number}] ${issue.title}`,
        issueBody(issue.number, issue.html_url, issue.body),
        'triage', priorityFromLabels(issue.labels), 'github', externalId, ts, ts,
      );
      created++;
    }
  });
    insertNew(issues);
    const result = { created, total: issues.length, skippedThrottle: false };
    emit?.({
      type: 'stop',
      operationId,
      kind: 'github_sync',
      title: `GitHub sync · ${project.name}`,
      status: 'succeeded',
      diagnostics: result,
    });
    return result;
  } catch (err: any) {
    emit?.({
      type: 'stop',
      operationId,
      kind: 'github_sync',
      title: `GitHub sync · ${project.name}`,
      status: 'failed',
      error: err?.message ?? 'GitHub sync failed',
    });
    throw err;
  }
}
