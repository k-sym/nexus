/**
 * What Docker Compose services a session has running — for the UI.
 *
 * `docker_service` (the agent tool) starts and stops services; this is the
 * read side that lets a human *see* them, so a leaked stack is visible rather
 * than inferred (#264 Phase 2). It groups every Nexus-owned container by its
 * compose project and flags the projects no live thread owns — the same
 * orphan test the startup sweep uses, surfaced live instead of only at boot.
 *
 * Container listing goes through `docker ps` with a tab-delimited format rather
 * than `compose ps`, because that needs neither a compose file nor a cwd — the
 * project label is on the container, so orphans (whose repo may be gone) list
 * just like live ones.
 */
import type Database from 'better-sqlite3';
import { isNexusProject, realDockerExec, type DockerExec } from './compose.js';
import { composeProjectName } from './compose.js';
import { liveThreadIds } from './sweep.js';

/** One running (or stopped) container in a project. */
export interface ServiceContainer {
  name: string;
  image: string;
  /** created / running / restarting / exited / paused / dead. */
  state: string;
  /** Human status line, e.g. "Up 3 minutes" or "Exited (0) 1 minute ago". */
  status: string;
  /** Published ports, as Docker prints them (empty when none). */
  ports: string;
}

/** A compose project and its containers, with whether a live thread owns it. */
export interface ServiceGroup {
  project: string;
  /** True when no live chat thread or mission maps to this project — a leak. */
  orphaned: boolean;
  containers: ServiceContainer[];
}

const PS_FORMAT = '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}';

/** Parse one tab-delimited `docker ps` line. Returns null for a malformed row
 *  rather than throwing — one odd line must not blank the whole panel. */
export function parsePsLine(line: string): (ServiceContainer & { project: string }) | null {
  const parts = line.split('\t');
  if (parts.length < 6) return null;
  const [project, name, state, status, ports, image] = parts;
  if (!project || !name) return null;
  return { project, name, state, status, ports: ports ?? '', image: image ?? '' };
}

/**
 * List every Nexus compose project with containers, grouped and orphan-flagged.
 *
 * `-a` so exited containers show too — a service that crashed on start is
 * exactly what someone opening this panel wants to see. Live-thread ids are read
 * AFTER the container list, matching the sweep's ordering rationale: a project
 * can only exist if its thread already does, so the later read can't miss it and
 * wrongly flag a live thread as an orphan.
 */
export async function listServiceGroups(
  db: Database.Database,
  exec: DockerExec = realDockerExec,
): Promise<ServiceGroup[]> {
  const result = await exec(['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', PS_FORMAT], {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) return [];

  const byProject = new Map<string, ServiceContainer[]>();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parsePsLine(line);
    if (!parsed || !isNexusProject(parsed.project)) continue;
    const { project, ...container } = parsed;
    const list = byProject.get(project) ?? [];
    list.push(container);
    byProject.set(project, list);
  }

  let owned: Set<string>;
  try {
    owned = new Set(liveThreadIds(db).map(composeProjectName));
  } catch {
    // Without a trustworthy live set, flag nothing as an orphan rather than
    // mislabel a running thread's stack as a leak.
    owned = new Set(byProject.keys());
  }

  return [...byProject.entries()]
    .map(([project, containers]) => ({ project, orphaned: !owned.has(project), containers }))
    // Orphans first (the actionable ones), then alphabetical for stability.
    .sort((a, b) => (Number(b.orphaned) - Number(a.orphaned)) || a.project.localeCompare(b.project));
}
