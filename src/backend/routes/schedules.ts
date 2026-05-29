import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { Schedule } from '@nexus/shared';
import { getNextRun, isValidCron, describeCron } from '../scheduler/cron';

export async function registerScheduleRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/projects/:projectId/schedules', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const rows = db.prepare('SELECT * FROM schedules WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Schedule[];
    return rows.map(s => ({ ...s, enabled: !!s.enabled, description_human: describeCron(s.cron_expr) }));
  });

  fastify.post('/api/projects/:projectId/schedules', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as {
      name: string;
      cron_expr: string;
      task_template: string;
      task_description?: string;
      agent_id: string;
    };

    if (!isValidCron(body.cron_expr)) {
      const err = new Error(`Invalid cron expression: ${body.cron_expr}`) as any;
      err.statusCode = 400;
      throw err;
    }

    const now = new Date().toISOString();
    const next = getNextRun(body.cron_expr);

    const schedule: Schedule = {
      id: uuid(),
      project_id: projectId,
      name: body.name,
      cron_expr: body.cron_expr,
      task_template: body.task_template,
      task_description: body.task_description || '',
      agent_id: body.agent_id,
      enabled: true,
      last_run: null,
      next_run: next ? next.toISOString() : null,
      created_at: now,
    };

    db.prepare(
      `INSERT INTO schedules (id, project_id, name, cron_expr, task_template, task_description, agent_id, enabled, last_run, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`
    ).run(
      schedule.id, schedule.project_id, schedule.name, schedule.cron_expr,
      schedule.task_template, schedule.task_description, schedule.agent_id,
      schedule.next_run, schedule.created_at,
    );

    return schedule;
  });

  fastify.put('/api/schedules/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<{
      name: string;
      cron_expr: string;
      task_template: string;
      task_description: string;
      agent_id: string;
      enabled: boolean;
    }>;

    const existing = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Schedule | undefined;
    if (!existing) {
      const err = new Error('Schedule not found') as any;
      err.statusCode = 404;
      throw err;
    }

    if (body.cron_expr && !isValidCron(body.cron_expr)) {
      const err = new Error(`Invalid cron expression: ${body.cron_expr}`) as any;
      err.statusCode = 400;
      throw err;
    }

    const cronExpr = body.cron_expr ?? existing.cron_expr;
    const next = getNextRun(cronExpr);

    db.prepare(
      `UPDATE schedules SET
         name = COALESCE(?, name),
         cron_expr = COALESCE(?, cron_expr),
         task_template = COALESCE(?, task_template),
         task_description = COALESCE(?, task_description),
         agent_id = COALESCE(?, agent_id),
         enabled = COALESCE(?, enabled),
         next_run = ?
       WHERE id = ?`
    ).run(
      body.name ?? null,
      body.cron_expr ?? null,
      body.task_template ?? null,
      body.task_description ?? null,
      body.agent_id ?? null,
      body.enabled === undefined ? null : (body.enabled ? 1 : 0),
      next ? next.toISOString() : null,
      id,
    );

    const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Schedule;
    return { ...updated, enabled: !!updated.enabled };
  });

  fastify.delete('/api/schedules/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return { success: true };
  });
}
