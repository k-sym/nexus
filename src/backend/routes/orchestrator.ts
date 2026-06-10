import { FastifyInstance } from 'fastify';

export async function registerOrchestratorRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/agents/status', async () => {
    const running = db.prepare(
      `SELECT ar.id, ar.task_id, t.title as task_title, ar.provider, ar.model, ar.started_at
       FROM agent_runs ar
       JOIN tasks t ON t.id = ar.task_id
       WHERE ar.status = 'running'
       ORDER BY ar.started_at DESC`
    ).all();

    const recent = db.prepare(
      `SELECT ar.id, ar.task_id, t.title as task_title, ar.status,
              ar.provider, ar.model, ar.duration_ms,
              ar.started_at, ar.completed_at
       FROM agent_runs ar
       JOIN tasks t ON t.id = ar.task_id
       ORDER BY ar.started_at DESC
       LIMIT 15`
    ).all();

    return { running, recent };
  });

  fastify.get('/api/agents/runs/:taskId', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const runs = db.prepare(
      `SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at DESC`
    ).all(taskId);
    return runs;
  });

  fastify.post('/api/orchestrator/tasks/:taskId/start', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { modelKey } = request.body as { modelKey?: string };
    if (!modelKey) {
      reply.code(400);
      return { error: 'modelKey required' };
    }
    if (!modelKey.includes('/')) {
      reply.code(400);
      return { error: 'modelKey must be in `provider/id` form' };
    }
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    // The model picker only sets the key; the orchestrator poll will
    // dispatch on the next tick. Move the task to in_progress here so
    // the UI immediately reflects the change.
    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET model_key = ?, status = ?, updated_at = ? WHERE id = ?').run(
      modelKey,
      'in_progress',
      now,
      taskId,
    );
    return { ok: true };
  });
}
