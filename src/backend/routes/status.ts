/**
 * Mission Control status endpoint.
 *
 * Aggregates the project-less, cross-cutting signals for the Mission Control
 * landing view: memory-daemon health, the pi runtime's available models
 * (with per-provider auth health), and recent agent activity. The legacy
 * "persona roster" surface is gone — the model registry is the new ground
 * truth.
 */
import { FastifyInstance } from 'fastify';
import { daemon } from '../memory/client';

export async function registerStatusRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/mission-control', async () => {
    // Memory daemon health (degrades gracefully if unreachable).
    let memory: Record<string, unknown>;
    try {
      memory = { ok: true, ...(await daemon.health()) };
    } catch (err: any) {
      memory = { ok: false, error: err.message };
    }

    // Available models with per-provider credential health. The pi
    // runtime's ModelRegistry has the curated list and knows which
    // providers have auth configured (so we can mark the rest
    // "unconfigured").
    const all = fastify.pi.models.getAll();
    const available = fastify.pi.models.getAvailable();
    const configuredIds = new Set(available.map((m) => `${m.provider}/${m.id}`));
    const models = all.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      configured: configuredIds.has(`${m.provider}/${m.id}`),
    }));

    // Recent activity across all projects.
    const running = db
      .prepare(
        `SELECT ar.id, ar.task_id, t.title as task_title, ar.provider, ar.model, ar.started_at
         FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id
         WHERE ar.status = 'running' ORDER BY ar.started_at DESC LIMIT 10`,
      )
      .all();
    const recent = db
      .prepare(
        `SELECT ar.id, ar.task_id, t.title as task_title, ar.status, ar.provider, ar.model,
                ar.total_tokens, ar.duration_ms, ar.started_at, ar.completed_at
         FROM agent_runs ar JOIN tasks t ON t.id = ar.task_id
         ORDER BY ar.started_at DESC LIMIT 10`,
      )
      .all();

    return { memory, models, activity: { running, recent } };
  });
}
