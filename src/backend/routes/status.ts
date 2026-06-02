/**
 * Mission Control status endpoint.
 *
 * Aggregates the project-less, cross-cutting signals for the Mission Control
 * landing view: memory-daemon health, scheduler/heartbeat, a per-agent health
 * probe, and recent agent activity. This is the one genuinely new backend
 * surface the shell redesign needs (design §5.1).
 */
import { FastifyInstance } from 'fastify';
import yaml from 'js-yaml';
import { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config';
import { daemon } from '../memory/client';

type AgentStatus = 'online' | 'ready' | 'offline';

interface PersonaRow {
  id: string;
  name: string;
  slug: string;
  config_yaml: string;
}

/** Probe a local OpenAI-compatible server's /models endpoint (short timeout). */
async function probeLocalModels(baseUrl: string): Promise<{ status: AgentStatus; latencyMs?: number }> {
  if (!baseUrl) return { status: 'offline' };
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return { status: res.ok ? 'online' : 'offline', latencyMs: Date.now() - start };
  } catch {
    return { status: 'offline' };
  }
}

/**
 * Derive an agent's status from its provider. `online` = adapter/server reachable
 * and healthy; `ready` = configured but idle/unverified (CLI adapters land in a
 * later step); `offline` = unreachable or not configured.
 */
async function probeAgent(p: PersonaRow, config: NexusConfig) {
  let provider = 'unknown';
  let model = '';
  try {
    const c = yaml.load(p.config_yaml) as { provider?: string; model?: string };
    provider = c?.provider ?? 'unknown';
    model = c?.model ?? '';
  } catch {
    /* malformed persona yaml — treat as unknown */
  }

  let status: AgentStatus = 'ready';
  let latencyMs: number | undefined;
  let detail: string | undefined;

  switch (provider) {
    case 'local':
    case 'ollama': {
      const r = await probeLocalModels(config.models.local.base_url);
      status = r.status;
      latencyMs = r.latencyMs;
      detail = config.models.local.base_url || 'no base_url';
      break;
    }
    case 'openrouter':
      status = config.models.openrouter.api_key ? 'ready' : 'offline';
      detail = config.models.openrouter.api_key ? 'api key set' : 'no api key';
      break;
    case 'claude_code':
    case 'codex':
      status = 'ready';
      detail = 'CLI · adapter pending';
      break;
    default:
      status = model ? 'ready' : 'offline';
  }

  return { slug: p.slug, name: p.name, provider, model, status, latencyMs, detail };
}

export async function registerStatusRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/mission-control', async () => {
    const config = loadConfig();

    // Memory daemon health (degrades gracefully if unreachable).
    let memory: Record<string, unknown>;
    try {
      memory = { ok: true, ...(await daemon.health()) };
    } catch (err: any) {
      memory = { ok: false, error: err.message };
    }

    // Scheduler / heartbeat — derived from the schedules table (no in-memory tick).
    const sched = db
      .prepare(
        `SELECT COUNT(*) as schedules, MAX(last_run) as lastRun, MIN(next_run) as nextRun
         FROM schedules WHERE enabled = 1`,
      )
      .get() as { schedules: number; lastRun: string | null; nextRun: string | null };
    const scheduler = {
      enabled: config.scheduler.enabled,
      intervalSeconds: config.scheduler.check_interval_seconds,
      schedules: sched.schedules ?? 0,
      lastRun: sched.lastRun ?? null,
      nextRun: sched.nextRun ?? null,
    };

    // Agent roster with per-provider health.
    const personas = db
      .prepare('SELECT id, name, slug, config_yaml FROM personas')
      .all() as PersonaRow[];
    const agents = await Promise.all(personas.map(p => probeAgent(p, config)));

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

    return { memory, scheduler, agents, activity: { running, recent } };
  });
}
