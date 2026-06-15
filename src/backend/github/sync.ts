/**
 * Sync a project's open GitHub issues into Triage tasks. Throttled per project
 * so it's cheap to call on every Kanban navigation, and deduped by
 * (external_source, external_id) so re-syncs never duplicate or disturb a task
 * once it exists — regardless of which column it has been moved to.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Project } from '@nexus/shared';
import { parseGitHubRepo, detectGitRemote } from './repo.js';
import { fetchOpenIssues } from './client.js';

const THROTTLE_MS = 3 * 60 * 1000; // at most one network sync per project per 3 min
const lastSyncAt = new Map<string, number>();

/** Test helper: clear the in-memory throttle between cases. */
export function __resetThrottle(): void {
  lastSyncAt.clear();
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

  const ref = parseGitHubRepo(project.git_remote || '');
  if (!ref) return { created: 0, total: 0, skippedThrottle: false };

  const last = lastSyncAt.get(project.id);
  if (last !== undefined && now() - last < THROTTLE_MS) {
    return { created: 0, total: 0, skippedThrottle: true };
  }
  lastSyncAt.set(project.id, now());

  const token = opts.token ?? process.env.GITHUB_TOKEN;
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
        'triage', 'medium', 'github', externalId, ts, ts,
      );
      created++;
    }
  });
  insertNew(issues);

  return { created, total: issues.length, skippedThrottle: false };
}
