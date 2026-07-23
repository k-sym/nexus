/**
 * Orphaned-container sweep.
 *
 * `dropSession()` tears down a thread's services, but it only runs when Nexus
 * is alive to run it. A crash, a `kill -9`, or a session dropped while Docker
 * was unreachable all leave containers with no owner. This is the backstop.
 *
 * It works because a thread's compose project name is *derived* from its thread
 * id rather than recorded: the set of projects Nexus could legitimately own is
 * computable from the database alone, so anything else under the `nexus-`
 * prefix is by definition an orphan. No bookkeeping to lose, which matters
 * precisely because the case being cleaned up is the one where state was lost.
 *
 * `docker compose --project-name X down` needs no compose file and no
 * particular working directory — Compose reconstructs the project from its
 * container labels — so this cleans up even projects whose repo has since been
 * deleted. (Verified against Docker 29.4.0 / Compose v5.1.2.)
 *
 * Part of #264.
 */
import type Database from 'better-sqlite3';
import { composeDown, composeProjectName, listNexusProjects, type DockerExec } from './compose.js';

export interface SweepResult {
  /** Nexus-owned projects Docker reported. */
  found: string[];
  /** Projects torn down because no live thread maps to them. */
  removed: string[];
  /** Projects left alone because a live thread still owns them. */
  kept: string[];
  /** Projects that failed to tear down. Left for the next sweep. */
  failed: string[];
}

const EMPTY: SweepResult = { found: [], removed: [], kept: [], failed: [] };

/**
 * Every thread id that could legitimately own a compose project.
 *
 * Deliberately generous. A missed orphan is a leaked container — annoying, and
 * caught by the next sweep once its thread is really gone. A *wrongly* removed
 * project pulls the database out from under a thread that is mid-run. So when
 * in doubt this errs towards keeping, and every source of session thread ids
 * has to be represented here:
 *
 *   - chat threads, whose row id IS the pi thread id (routes/chat.ts)
 *   - missions, which use `mission-<id>` unless their config names a thread
 *     (missions/handlers/assistant-turn.ts)
 *
 * Archived chat threads count as live: archiving does not drop the session.
 */
export function liveThreadIds(db: Database.Database): string[] {
  const ids: string[] = [];
  try {
    for (const row of db.prepare('SELECT id FROM chat_threads').all() as Array<{ id: string }>) {
      if (row?.id) ids.push(String(row.id));
    }
  } catch { /* table missing on a fresh db — nothing to protect */ }

  try {
    const rows = db.prepare('SELECT id, config_json FROM missions').all() as Array<{ id: string; config_json: string }>;
    for (const row of rows) {
      if (!row?.id) continue;
      ids.push(`mission-${row.id}`);
      // A mission may pin an explicit thread id; that session is just as live.
      try {
        const config = JSON.parse(row.config_json || '{}');
        const pinned = config?.thread_id;
        if (typeof pinned === 'string' && pinned.trim()) ids.push(pinned.trim());
      } catch { /* malformed config: the mission-<id> form above still covers it */ }
    }
  } catch { /* no missions table */ }

  return ids;
}

export interface SweepOptions {
  exec?: DockerExec;
  /** Skip entirely when Docker isn't reachable. */
  isAvailable?: () => boolean;
  /** Injection seam for tests. */
  getLiveThreadIds?: (db: Database.Database) => string[];
}

/**
 * Tear down Nexus compose projects that no live thread owns.
 *
 * Ordering matters: projects are listed BEFORE the live set is read. A project
 * can only exist if some thread called the tool, which requires that thread's
 * row to already exist — so reading the database afterwards is guaranteed to
 * see it. Reading in the other order would open a window where a thread created
 * between the two reads had its containers swept.
 */
export async function sweepOrphanedProjects(
  db: Database.Database,
  options: SweepOptions = {},
): Promise<SweepResult> {
  if (options.isAvailable && !options.isAvailable()) return { ...EMPTY };

  const exec = options.exec;
  let found: string[];
  try {
    found = await listNexusProjects(exec);
  } catch {
    // A daemon that won't answer is not an error worth failing startup over.
    return { ...EMPTY };
  }
  if (found.length === 0) return { ...EMPTY };

  const getLive = options.getLiveThreadIds ?? liveThreadIds;
  let owned: Set<string>;
  try {
    owned = new Set(getLive(db).map(composeProjectName));
  } catch {
    // Without a trustworthy live set we cannot tell an orphan from a running
    // thread's stack, and removing the wrong one is far worse than leaking.
    // Do nothing and let the next sweep try again.
    return { ...EMPTY, found };
  }

  const removed: string[] = [];
  const kept: string[] = [];
  const failed: string[] = [];

  for (const projectName of found) {
    if (owned.has(projectName)) {
      kept.push(projectName);
      continue;
    }
    try {
      // No cwd: Compose reads the project from container labels, so this works
      // even when the repo the containers came from no longer exists.
      const result = await composeDown({ projectName, exec });
      if (result.code === 0) removed.push(projectName);
      else failed.push(projectName);
    } catch {
      failed.push(projectName);
    }
  }

  return { found, removed, kept, failed };
}

/** One-line summary for the startup log. Returns null when there was nothing
 *  to say, so a normal boot stays quiet. */
export function describeSweep(result: SweepResult): string | null {
  if (result.removed.length === 0 && result.failed.length === 0) return null;
  const parts: string[] = [];
  if (result.removed.length > 0) {
    parts.push(`removed ${result.removed.length} orphaned service group(s): ${result.removed.join(', ')}`);
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} could not be removed: ${result.failed.join(', ')}`);
  }
  return `[docker] ${parts.join('; ')}`;
}
