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
              ar.provider, ar.model,
              ar.prompt_tokens, ar.completion_tokens, ar.total_tokens, ar.duration_ms,
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

  // Aggregate token usage stats, optionally scoped to a project.
  fastify.get('/api/agents/usage', async (request) => {
    const { projectId } = request.query as { projectId?: string };

    // "Active" providers are those with credentials configured in
    // pi's AuthStorage right now. Historical runs for providers whose
    // auth has since been removed (or were never ours, e.g. legacy
    // build artifacts) are dropped from both totals and the breakdown
    // so they don't keep showing up after a logout.
    const activeProviders = fastify.pi.auth.list();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      conditions.push('(ar.project_id = ? OR ar.task_id IN (SELECT id FROM tasks WHERE project_id = ?))');
      params.push(projectId, projectId);
    }
    if (activeProviders.length > 0) {
      conditions.push(`ar.provider IN (${activeProviders.map(() => '?').join(',')})`);
      params.push(...activeProviders);
    } else {
      // No active providers → no usage. Keeps totals and the breakdown
      // consistent (zeros, not the full historical archive).
      conditions.push('1 = 0');
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totals = db.prepare(
      `SELECT
         COUNT(*) as runs,
         COALESCE(SUM(ar.prompt_tokens), 0) as prompt_tokens,
         COALESCE(SUM(ar.completion_tokens), 0) as completion_tokens,
         COALESCE(SUM(ar.total_tokens), 0) as total_tokens,
         COALESCE(SUM(ar.duration_ms), 0) as duration_ms
       FROM agent_runs ar ${whereSql}`
    ).get(...params) as any;

    const byProvider = db.prepare(
      `SELECT
         ar.provider,
         COUNT(*) as runs,
         COALESCE(SUM(ar.total_tokens), 0) as total_tokens
       FROM agent_runs ar
       WHERE ar.provider IS NOT NULL${conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : ''}
       GROUP BY ar.provider
       ORDER BY total_tokens DESC`
    ).all(...params);

    return { totals, byProvider };
  });
}
