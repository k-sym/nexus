/**
 * Stale-item detection across every scoped project — the read the partner's
 * daily "no movement" check (baker-internal #59) calls, so it never needs a
 * second Monday client or its own copy of the token.
 *
 * "Movement" is the latest of three clocks, because each one alone misses
 * something: Monday's own `updated_at` on the item (a column edit, a status
 * change), the newest entry in the item's update thread (a comment is
 * movement even when no column changed), and the newest `updated_at` of any
 * Nexus task linked to it (a Kanban move is movement Monday cannot see until
 * the roll-up or status sync writes it back).
 *
 * Pure over the mirror: it reads what the last sync stored and never calls
 * Monday itself. The route decides whether to refresh first.
 */
import type Database from 'better-sqlite3';
import type { MondayItem, MondayProjectConfig, Project, TaskStatus } from '@nexus/shared';
import { listItemsForBoard } from './store.js';

export interface StaleLinkedTask {
  id: string;
  title: string;
  status: TaskStatus;
  updated_at: string;
}

export interface StaleItem {
  item_id: string;
  name: string;
  url: string | null;
  group_title: string | null;
  status_label: string | null;
  owners: string[];
  /** ISO timestamp of the latest movement seen, or null when nothing on the
   *  item carries a date at all (then it is reported as stale). */
  last_movement: string | null;
  /** Whole days since last_movement at `now`; null when last_movement is null. */
  days_idle: number | null;
  linked_tasks: StaleLinkedTask[];
}

export interface StaleProject {
  project_id: string;
  project_name: string;
  board_id: string;
  board_name: string;
  group_id: string | null;
  /** Newest `synced_at` in the scope — how fresh the mirror this was computed from is. */
  synced_at: string | null;
  items: StaleItem[];
}

export interface StaleReport {
  days: number;
  generated_at: string;
  projects: StaleProject[];
}

export interface ScopedProject {
  project: Project;
  cfg: MondayProjectConfig;
}

/** Every project with a Monday scope, in Kanban sort order. */
export function listScopedProjects(db: Database.Database): ScopedProject[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY sort_order, name').all() as Project[];
  const out: ScopedProject[] = [];
  for (const project of rows) {
    try {
      const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
      if (parsed.monday?.board_id) out.push({ project, cfg: parsed.monday });
    } catch {
      // A corrupted config_json is that project's problem, not the report's.
    }
  }
  return out;
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function newestUpdateAt(item: MondayItem): number | null {
  try {
    const parsed: unknown = JSON.parse(item.updates_json || '[]');
    if (!Array.isArray(parsed)) return null;
    let newest: number | null = null;
    for (const u of parsed) {
      const t = parseIso(typeof u === 'object' && u !== null ? (u as { created_at?: string }).created_at : null);
      if (t !== null && (newest === null || t > newest)) newest = t;
    }
    return newest;
  } catch {
    return null;
  }
}

function owners(item: MondayItem): string[] {
  try {
    const parsed: unknown = JSON.parse(item.owners_json || '[]');
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Build the report. `days` is the idle threshold; items whose latest movement
 * is at least that many days before `now` are included, as are items with no
 * dated movement at all. Archived, deleted, and missing items are skipped —
 * they are not stalled, they are gone. `excludeLabels` drops items whose
 * status label matches (case-insensitive), so a consumer can leave "Done"
 * out without re-implementing the walk.
 */
export function buildStaleReport(
  db: Database.Database,
  days: number,
  now: Date = new Date(),
  excludeLabels: string[] = [],
): StaleReport {
  const threshold = now.getTime() - days * 86_400_000;
  const excluded = new Set(excludeLabels.map((l) => l.trim().toLowerCase()).filter(Boolean));
  const linkedTasksStmt = db.prepare(`
    SELECT t.id, t.title, t.status, t.updated_at
    FROM task_monday_links l JOIN tasks t ON t.id = l.task_id
    WHERE l.item_id = ?
    ORDER BY t.updated_at DESC
  `);

  const projects: StaleProject[] = [];
  for (const { project, cfg } of listScopedProjects(db)) {
    const items = listItemsForBoard(db, cfg.board_id, cfg.group_id ?? null);
    let syncedAt: string | null = null;
    const stale: StaleItem[] = [];
    for (const item of items) {
      if (!syncedAt || item.synced_at > syncedAt) syncedAt = item.synced_at;
      if (item.state !== 'active') continue;
      if (item.status_label && excluded.has(item.status_label.trim().toLowerCase())) continue;

      const linked = linkedTasksStmt.all(item.item_id) as StaleLinkedTask[];
      const clocks = [
        parseIso(item.monday_updated_at),
        newestUpdateAt(item),
        ...linked.map((t) => parseIso(t.updated_at)),
      ].filter((t): t is number => t !== null);
      const last = clocks.length > 0 ? Math.max(...clocks) : null;
      if (last !== null && last > threshold) continue;

      stale.push({
        item_id: item.item_id,
        name: item.name,
        url: item.url,
        group_title: item.group_title,
        status_label: item.status_label,
        owners: owners(item),
        last_movement: last === null ? null : new Date(last).toISOString(),
        days_idle: last === null ? null : Math.floor((now.getTime() - last) / 86_400_000),
        linked_tasks: linked,
      });
    }
    // Longest idle first; undated items (never seen moving) at the top.
    stale.sort((a, b) => (b.days_idle ?? Number.MAX_SAFE_INTEGER) - (a.days_idle ?? Number.MAX_SAFE_INTEGER));
    projects.push({
      project_id: project.id,
      project_name: project.name,
      board_id: cfg.board_id,
      board_name: items[0]?.board_name ?? '',
      group_id: cfg.group_id ?? null,
      synced_at: syncedAt,
      items: stale,
    });
  }
  return { days, generated_at: now.toISOString(), projects };
}
