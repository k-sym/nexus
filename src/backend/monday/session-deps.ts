/**
 * Turns a chat thread into the Monday context and tools its session should get.
 *
 * A thread only gets any of this when its task has a link, so the vast
 * majority of sessions pay nothing: no injected block, no registered tools.
 * That is the same contract memory_recall follows — never advertise a tool
 * that cannot run.
 */
import type Database from 'better-sqlite3';
import type { MondayItem, MondayProjectConfig, Project, TaskStatus } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from './poll.js';
import { getItem, listLinkedTaskStatuses } from './store.js';
import { fetchBoardItems, type MondayClientOptions } from './client.js';
import { mapItem } from './map.js';
import { postItemUpdate } from './writes.js';
import { computeRollup, formatRollupText } from './rollup.js';
import type { MondayToolDeps, MondayItemDetail } from '../pi/monday-tool.js';
import type { MondayContextInput } from '../pi/monday-context.js';

interface ResolvedThread {
  item: MondayItem;
  projectId: string;
  cfg: MondayProjectConfig;
  taskId: string;
}

function projectMondayConfig(project: Project | undefined): MondayProjectConfig | null {
  if (!project) return null;
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

/** thread → task → link → item. Null when any hop is missing. */
export function resolveThreadItem(db: Database.Database, threadId: string): ResolvedThread | null {
  const row = db.prepare(`
    SELECT t.id AS task_id, t.project_id AS project_id, l.item_id AS item_id
    FROM tasks t
    JOIN task_monday_links l ON l.task_id = t.id
    WHERE t.thread_id = ?
  `).get(threadId) as { task_id: string; project_id: string; item_id: string } | undefined;
  if (!row) return null;

  const item = getItem(db, row.item_id);
  if (!item) return null;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) as Project | undefined;
  const cfg = projectMondayConfig(project);
  if (!cfg) return null;

  return { item, projectId: row.project_id, cfg, taskId: row.task_id };
}

/**
 * The item's recently-mirrored updates — Monday's per-item comment thread —
 * newest first.
 *
 * Reads `updates_json`, written by mapItem from the `updates` connection
 * client.ts fetches. Never `column_values_json`: that blob holds COLUMN
 * VALUES keyed by column id, so on a board with a column whose id is
 * literally "updates" reading it here (as this function once did) would show
 * the model that column's value dressed up as a comment — worse than showing
 * nothing.
 *
 * Total by construction. This runs during agent session creation, where a
 * throw means a chat thread that can never be opened again, so every
 * malformed shape a stored blob could hold — absent, non-JSON, not an array,
 * entries of the wrong shape — degrades to an empty list. That is also why
 * the field is re-validated here rather than trusted: rows written by any
 * past version of mapItem are still in the mirror.
 */
function recentUpdates(item: MondayItem): string[] {
  try {
    const parsed: unknown = JSON.parse(item.updates_json || '[]');
    // The catch below would also cover a non-array (`.filter` would throw),
    // but handling it here states the rule — "not a list, no updates" — as a
    // decision rather than leaving it to an incidental TypeError.
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((u): u is Record<string, unknown> => typeof u === 'object' && u !== null)
      .map((u) => ({
        text: typeof u.text === 'string' ? u.text.trim() : '',
        created_at: typeof u.created_at === 'string' ? u.created_at : null,
      }))
      .filter((u) => u.text.length > 0)
      // Newest first. Monday's timestamps are ISO-8601, which compares
      // correctly as plain strings; entries with no timestamp sort to the end
      // rather than disturbing the order of the ones that have one.
      .sort((a, b) => {
        if (a.created_at && b.created_at) return b.created_at.localeCompare(a.created_at);
        if (a.created_at) return -1;
        if (b.created_at) return 1;
        return 0;
      })
      .map((u) => u.text);
  } catch {
    return [];
  }
}

/** The global Monday kill switch (`monday.enabled` in config_json) AND the
 *  MONDAY_TOKEN check — the same two gates `clientOptions()` uses below for
 *  buildMondayToolDeps, and the ones routes/monday.ts already enforces. Both
 *  halves of a thread's Monday integration must agree: with the switch off,
 *  OR with no MONDAY_TOKEN (e.g. the app relaunched outside the shell that
 *  exported it), a linked thread gets neither the context block nor the
 *  tools — a context block that tells the model to "Call monday_get_item"
 *  when that tool was never registered is worse than no block at all. This
 *  mirrors the fix already made for the `enabled` half alone; the token half
 *  had the identical gap. */
function mondayReady(): boolean {
  return loadConfig().monday.enabled && Boolean(resolveMondayToken());
}

/**
 * Called during agent session creation (PiRuntime.createSession, via the
 * mondayContext resolver). That call site wraps this in its own try/catch,
 * but per the brief this must not rely on that — so the whole body is
 * guarded here too, defense-in-depth against anything unexpected (a bad row,
 * a DB hiccup) rather than only the JSON blobs it already parses defensively.
 * A throw here would otherwise mean an unopenable, permanently broken thread.
 */
export function buildMondayContext(db: Database.Database, threadId: string): MondayContextInput | null {
  try {
    if (!mondayReady()) return null;
    const resolved = resolveThreadItem(db, threadId);
    if (!resolved) return null;
    const counts = computeRollup(listLinkedTaskStatuses(db, resolved.item.item_id));
    return {
      item: resolved.item,
      rollupText: formatRollupText(counts),
      siblingCount: counts.total,
      updates: recentUpdates(resolved.item),
    };
  } catch (err: any) {
    console.error('[monday-context] buildMondayContext failed:', err?.message);
    return null;
  }
}

function clientOptions(): MondayClientOptions | null {
  if (!mondayReady()) return null;
  const cfg = loadConfig().monday;
  const token = resolveMondayToken();
  if (!token) return null;
  return { token, apiVersion: cfg.api_version };
}

/**
 * Called during agent session creation (PiRuntime.buildSessionExtensionFactories,
 * via the mondayTools resolver). That call site (`mondayTools?.(threadId)` in
 * pi/runtime.ts) now has its own try/catch too (MINOR 6), but this function
 * keeps its own guard regardless — belt and suspenders, not a dependency on
 * the caller. Everything synchronous is wrapped; the async
 * `search`/`getItem`/`postUpdate` closures below are only definitions here;
 * they run later, at tool-call time, where pi's agent loop already turns a
 * throw into a tool-error result (see monday-tool.ts) — a different,
 * already-handled contract.
 */
export function buildMondayToolDeps(db: Database.Database, threadId: string): MondayToolDeps | null {
  try {
    const resolved = resolveThreadItem(db, threadId);
    if (!resolved) return null;
    const opts = clientOptions();
    if (!opts) return null;

    const deps: MondayToolDeps = {
      async search(query, boardId) {
        const now = new Date().toISOString();
        const raw = await fetchBoardItems(opts, boardId ?? resolved.cfg.board_id, boardId ? null : resolved.cfg.group_id ?? null);
        const needle = query.toLowerCase();
        return raw.map((r) => mapItem(r, now)).filter((item) => item.name.toLowerCase().includes(needle)).slice(0, 25);
      },
      async getItem(itemId): Promise<MondayItemDetail | null> {
        const item = getItem(db, itemId);
        if (!item) return null;
        const linkedTasks = db.prepare(`
          SELECT t.id AS id, t.title AS title, t.status AS status
          FROM task_monday_links l JOIN tasks t ON t.id = l.task_id
          WHERE l.item_id = ?
        `).all(itemId) as { id: string; title: string; status: TaskStatus }[];
        return { item, updates: recentUpdates(item), linked_tasks: linkedTasks };
      },
    };

    // Registered only when the project opted in. Supervised threads still gate
    // the call through the existing ApprovalBroker, which wraps every tool call
    // in a supervised session — no extra gating is needed here.
    //
    // Optional chain deliberately: `cfg.updates` comes from JSON parsed out of
    // projects.config_json (projectMondayConfig() above), so a partial/legacy
    // `monday` block with no `updates` key at all is real, reachable data —
    // not a programmer error. `.updates.enabled` would throw on it, and the
    // outer catch would turn that into a null return that silently drops
    // search/getItem too, when only the opt-in gate should be affected
    // (MINOR 4). `?.enabled` without `?? false` reads correctly either way:
    // undefined is falsy, so a missing block still means "not opted in".
    if (resolved.cfg.updates?.enabled) {
      const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(resolved.taskId) as { title: string } | undefined;
      const provenance = `Nexus task "${task?.title ?? resolved.taskId}" (thread ${threadId})`;
      deps.postUpdate = async (itemId, body) => {
        await postItemUpdate(db, opts, itemId, body, provenance);
      };
    }

    return deps;
  } catch (err: any) {
    console.error('[monday-tools] buildMondayToolDeps failed:', err?.message);
    return null;
  }
}
