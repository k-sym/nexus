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
import { fetchBoardItems, MondayError, type MondayClientOptions } from '../monday/client.js';
import { mapItem } from '../monday/map.js';
import {
  listItemsForBoard, listLinksForProject, linkTask, unlinkTask, listLinkedTaskStatuses,
} from '../monday/store.js';
import { computeRollup, formatRollupText } from '../monday/rollup.js';

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

export async function registerMondayRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/monday/status', async () => {
    const cfg = loadConfig().monday;
    return { enabled: cfg.enabled, configured: cfg.enabled && Boolean(resolveMondayToken()) };
  });

  fastify.get('/api/monday/projects/:projectId/items', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { refresh } = request.query as { refresh?: string };

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) return reply.code(404).send({ error: 'project not found' });

    const cfg = projectMondayConfig(project);
    if (!cfg) return reply.code(409).send({ error: 'no Monday scope configured for this project' });

    if (refresh === '1') {
      const opts = clientOptions();
      if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set' });
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
    if (!cfg) return reply.code(409).send({ error: 'no Monday scope configured for this project' });
    const opts = clientOptions();
    if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set' });

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

    const link = { task_id: taskId, item_id: itemId, project_id: projectId, created_at: new Date().toISOString() };
    linkTask(db, link);
    return { link };
  });

  fastify.delete('/api/monday/links/:taskId', async (request) => {
    const { taskId } = request.params as { taskId: string };
    unlinkTask(db, taskId);
    return { ok: true };
  });
}
