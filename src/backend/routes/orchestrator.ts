import { FastifyInstance } from 'fastify';

export async function registerOrchestratorRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/agents/status', async () => {
    const running = db.prepare(
      `SELECT ar.id, ar.task_id, t.title as task_title, ar.provider, ar.model, ar.started_at
       FROM agent_runs ar
       LEFT JOIN tasks t ON t.id = ar.task_id
       WHERE ar.status = 'running'
       ORDER BY ar.started_at DESC`
    ).all();

    const recent = db.prepare(
      `SELECT ar.id, ar.task_id, t.title as task_title, ar.status,
              ar.provider, ar.model, ar.duration_ms,
              ar.started_at, ar.completed_at
       FROM agent_runs ar
       LEFT JOIN tasks t ON t.id = ar.task_id
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
}
