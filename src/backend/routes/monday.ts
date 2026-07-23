/**
 * /api/monday/* — the Project Management view's read paths and the link CRUD.
 *
 * The picker (`/search`) deliberately queries Monday live rather than reading
 * the mirror, so an item created thirty seconds ago is findable. Everything
 * else reads the mirror.
 *
 * Follows the same registration convention as the neighbouring route modules
 * (routes/tickets.ts, routes/braindump.ts): a FastifyInstance decorated with
 * `db` at app-boot in index.ts, not a bespoke `{ db }` deps argument.
 */
import type { FastifyInstance } from 'fastify';
import type { MondayProjectConfig, MondayItemWithLinks, Project, Task } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from '../monday/poll.js';
import { syncScope } from '../monday/sync.js';
import {
  fetchBoardItems, fetchItemsByIds, fetchBoards, fetchBoardMeta, MondayError, type MondayClientOptions,
} from '../monday/client.js';
import { mapItem } from '../monday/map.js';
import {
  listItemsForBoard, listLinksForProject, linkTask, unlinkTask, getLinkForTask, listLinkedTaskStatuses,
  getItem, upsertItems,
} from '../monday/store.js';
import { computeRollup, formatRollupText } from '../monday/rollup.js';
import { scheduleRollup, scheduleRollupForItem } from '../monday/trigger.js';

function projectMondayConfig(project: Project): MondayProjectConfig | null {
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

function clientOptions(): MondayClientOptions | null {
  const cfg = loadConfig().monday;
  const token = resolveMondayToken();
  if (!cfg.enabled || !token) return null;
  return { token, apiVersion: cfg.api_version };
}

/** A user cannot set 0 (or a negative number) and hammer Monday's API on
 *  every roll-up/update tick; this is the floor a valid-but-tiny interval is
 *  clamped up to rather than rejected outright (only <= 0 is rejected). */
const MIN_UPDATE_INTERVAL_MINUTES = 5;

/**
 * Server-side validation for PUT .../config. Never trust the UI alone: this
 * whitelists exactly the MondayProjectConfig shape, so (a) an unknown key —
 * including a `token` field, which this panel must never accept — is simply
 * never read, and (b) a malformed nested shape can't reach JSON.stringify and
 * get persisted verbatim.
 */
function validateMondayConfig(body: unknown): { config: MondayProjectConfig } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'request body must be a Monday scope config object' };
  const b = body as Record<string, unknown>;

  const boardId = typeof b.board_id === 'string' ? b.board_id.trim() : '';
  if (!boardId) return { error: 'board_id is required' };

  const groupId = typeof b.group_id === 'string' && b.group_id.trim() ? b.group_id.trim() : null;

  const rollupRaw = (b.rollup && typeof b.rollup === 'object') ? b.rollup as Record<string, unknown> : {};
  const rollupEnabled = rollupRaw.enabled === true;
  const rollupColumnId = typeof rollupRaw.column_id === 'string' && rollupRaw.column_id.trim()
    ? rollupRaw.column_id.trim()
    : null;
  // A roll-up switched on with nowhere to write is the misconfiguration that
  // later self-disables (see monday/trigger.ts) and notifies the user —
  // reject it up front instead of persisting a config that will do that.
  if (rollupEnabled && !rollupColumnId) {
    return { error: 'rollup.column_id is required when rollup.enabled is true' };
  }
  const columnType = rollupRaw.column_type;
  if (columnType !== 'text' && columnType !== 'numeric') {
    return { error: "rollup.column_type must be 'text' or 'numeric'" };
  }

  const updatesRaw = (b.updates && typeof b.updates === 'object') ? b.updates as Record<string, unknown> : {};
  const updatesEnabled = updatesRaw.enabled === true;
  const minInterval = updatesRaw.min_interval_minutes;
  if (typeof minInterval !== 'number' || !Number.isFinite(minInterval) || minInterval <= 0) {
    return { error: 'updates.min_interval_minutes must be a positive number' };
  }

  return {
    config: {
      board_id: boardId,
      group_id: groupId,
      rollup: { enabled: rollupEnabled, column_id: rollupColumnId, column_type: columnType },
      updates: { enabled: updatesEnabled, min_interval_minutes: Math.max(minInterval, MIN_UPDATE_INTERVAL_MINUTES) },
    },
  };
}

export async function registerMondayRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/monday/status', async () => {
    const cfg = loadConfig().monday;
    return { enabled: cfg.enabled, configured: cfg.enabled && Boolean(resolveMondayToken()) };
  });

  // Live board/column pickers for the per-project scope config panel
  // (MondayScopeSettings.tsx). Both are read-only queries — see the two-
  // mutations-only rule in monday/client.ts — and both 502 on a Monday
  // failure rather than degrading to an empty list, same as /items and
  // /search below: a user must never read "you have no boards" when their
  // token expired.

  fastify.get('/api/monday/boards', async (_request, reply) => {
    const opts = clientOptions();
    if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set', code: 'monday_disabled' });
    try {
      const boards = await fetchBoards(opts);
      return { boards };
    } catch (err) {
      const monday = err as MondayError;
      return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
    }
  });

  fastify.get('/api/monday/boards/:boardId/meta', async (request, reply) => {
    const { boardId } = request.params as { boardId: string };
    const opts = clientOptions();
    if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set', code: 'monday_disabled' });
    try {
      const meta = await fetchBoardMeta(opts, boardId);
      return meta;
    } catch (err) {
      const monday = err as MondayError;
      return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
    }
  });

  // Read/write the project's own Monday scope — never a live Monday call, so
  // neither of these depends on clientOptions()/the token being set. This is
  // the validated path for Monday settings; the opaque PUT /api/projects/:id
  // config_json passthrough is deliberately not used for this.

  fastify.get('/api/monday/projects/:projectId/config', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { config: projectMondayConfig(project) };
  });

  fastify.put('/api/monday/projects/:projectId/config', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });

    const validated = validateMondayConfig(request.body);
    if ('error' in validated) return reply.code(400).send({ error: validated.error });

    // Read-modify-write: config_json also holds column_defaults (and any
    // future sibling settings). Only the `monday` key is touched here, so a
    // save from this panel can never clobber them.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(project.config_json || '{}') as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    parsed.monday = validated.config;

    db.prepare('UPDATE projects SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(parsed), new Date().toISOString(), projectId);
    return { config: validated.config };
  });

  fastify.get('/api/monday/projects/:projectId/items', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { refresh } = request.query as { refresh?: string };

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });

    const cfg = projectMondayConfig(project);
    if (!cfg) return reply.code(409).send({ error: 'no Monday scope configured for this project', code: 'unconfigured' });

    if (refresh === '1') {
      const opts = clientOptions();
      if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set', code: 'monday_disabled' });
      try {
        await syncScope(db, opts, cfg.board_id, cfg.group_id ?? null, new Date().toISOString());
      } catch (err) {
        const monday = err as MondayError;
        return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
      }
    }

    const links = listLinksForProject(db, project.id);
    const byItem = new Map<string, string[]>();
    for (const link of links) {
      byItem.set(link.item_id, [...(byItem.get(link.item_id) ?? []), link.task_id]);
    }

    const items: MondayItemWithLinks[] = listItemsForBoard(db, cfg.board_id, cfg.group_id ?? null)
      .map((item) => {
        const counts = computeRollup(listLinkedTaskStatuses(db, item.item_id));
        return { ...item, rollup: counts, rollup_text: formatRollupText(counts), task_ids: byItem.get(item.item_id) ?? [] };
      });
    return { items };
  });

  fastify.get('/api/monday/projects/:projectId/search', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { q } = request.query as { q?: string };

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const cfg = projectMondayConfig(project);
    if (!cfg) return reply.code(409).send({ error: 'no Monday scope configured for this project', code: 'unconfigured' });
    const opts = clientOptions();
    if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set', code: 'monday_disabled' });

    const query = (q ?? '').trim().toLowerCase();
    try {
      const now = new Date().toISOString();
      const raw = await fetchBoardItems(opts, cfg.board_id, cfg.group_id ?? null);
      const items = raw
        .map((r) => mapItem(r, now))
        .filter((item) => !query || item.name.toLowerCase().includes(query))
        .slice(0, 50);
      return { items };
    } catch (err) {
      const monday = err as MondayError;
      return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
    }
  });

  fastify.get('/api/monday/projects/:projectId/links', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { links: listLinksForProject(db, project.id) };
  });

  fastify.post('/api/monday/links', async (request, reply) => {
    const body = request.body as { task_id?: string; item_id?: string; project_id?: string };
    const { task_id: taskId, item_id: itemId, project_id: projectId } = body ?? {};
    if (!taskId || !itemId || !projectId) {
      return reply.code(400).send({ error: 'task_id, item_id and project_id are required' });
    }

    // The table has no FK constraints, so without these checks a caller can
    // link a task_id that doesn't exist (an orphan `/links` surfaces forever)
    // or attach a task from project A to project B's link list, silently
    // polluting B's roll-up. 404 for unknown ids matches the "project not
    // found" convention already used by GET /items and /search; 400 for a
    // well-formed-but-inconsistent combination matches the 400 this same
    // handler already returns for missing fields.
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (task.project_id !== projectId) {
      return reply.code(400).send({ error: 'task does not belong to that project' });
    }

    // The picker searches Monday LIVE (see the module docblock), so it can
    // hand back an item that has never been through a scope sync and has no
    // row in monday_items yet. writeRollup reads the item via
    // getItem(db, itemId); with no row it silently returns 'skipped' — no
    // roll-up write, no badge, no agent context — and self-heals only on the
    // NEXT background poll, which does not itself re-trigger the roll-up
    // (poll.ts only refreshes; it never calls scheduleRollup). Mirror the
    // item now, before the link is created, so a fresh link reflects
    // immediately rather than staying stale until some other task on the
    // same item happens to move.
    if (!getItem(db, itemId)) {
      const opts = clientOptions();
      if (opts) {
        try {
          const raw = await fetchItemsByIds(opts, [itemId]);
          if (raw.length > 0) upsertItems(db, raw.map((r) => mapItem(r, new Date().toISOString())));
        } catch (err) {
          const monday = err as MondayError;
          // Surface exactly like the sibling live-call routes (GET
          // items?refresh=1, GET search) do, and leave no half-created
          // state: the link row below is only ever inserted after this
          // succeeds (or is skipped because no live client is available).
          return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
        }
      }
    }

    const link = { task_id: taskId, item_id: itemId, project_id: projectId, created_at: new Date().toISOString() };
    linkTask(db, link);
    // Same `fastify.activity?.bus.emit` seam the Kanban status-change path in
    // routes/projects.ts already reaches the ActivityManager through — without
    // it this write was invisible in the Activity Console (only Kanban moves
    // produced a monday_write operation).
    void scheduleRollup(db, taskId, 'task linked', fastify.activity?.bus.emit.bind(fastify.activity.bus));
    return { link };
  });

  fastify.delete('/api/monday/links/:taskId', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const existing = getLinkForTask(db, taskId);
    unlinkTask(db, taskId);
    if (existing) {
      // Recompute the item we just detached from, or it keeps a count that
      // still includes this task. Same emitter seam as the link handler above.
      void scheduleRollupForItem(
        db, existing.item_id, existing.project_id, null,
        fastify.activity?.bus.emit.bind(fastify.activity.bus),
      );
    }
    return { ok: true };
  });
}
