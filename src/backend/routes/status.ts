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
import { NexusConfig, Provider } from '@nexus/shared';
import { loadConfig, resolveEnvVars } from '../config';
import { daemon } from '../memory/client';
import { hermesHealthUrl } from '../orchestrator/providers';

type AgentStatus = 'online' | 'ready' | 'offline';

interface PersonaRow {
  id: string;
  name: string;
  slug: string;
  config_yaml: string;
}

/** Probe an OpenAI-compatible server's /models endpoint (short timeout). */
async function probeLocalModels(baseUrl: string, apiKey?: string): Promise<{ status: AgentStatus; latencyMs?: number }> {
  if (!baseUrl) return { status: 'offline' };
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: ctrl.signal });
    clearTimeout(timer);
    return { status: res.ok ? 'online' : 'offline', latencyMs: Date.now() - start };
  } catch {
    return { status: 'offline' };
  }
}

/** Probe a Hermes agent's /health endpoint. online iff it returns {"status":"ok"}. */
async function probeHermes(baseUrl: string): Promise<{ status: AgentStatus; latencyMs?: number; detail?: string }> {
  if (!baseUrl) return { status: 'offline', detail: 'no base_url' };
  const url = hermesHealthUrl(baseUrl);
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const body: any = await res.json().catch(() => ({}));
    const ok = res.ok && body?.status === 'ok';
    return { status: ok ? 'online' : 'offline', latencyMs: Date.now() - start, detail: body?.platform || url };
  } catch {
    return { status: 'offline', detail: 'unreachable' };
  }
}

/**
 * Derive an agent's status from its provider. `online` = adapter/server reachable
 * and healthy; `ready` = configured but idle/unverified (CLI adapters land in a
 * later step); `offline` = unreachable or not configured.
 */
async function probeAgent(p: PersonaRow, config: NexusConfig, providersById: Map<string, Provider>) {
  let c: { provider?: string; provider_id?: string; model?: string } = {};
  try { c = (yaml.load(p.config_yaml) as typeof c) ?? {}; } catch { /* malformed yaml */ }

  // Resolve the linked provider record (preferred) or fall back to the legacy enum.
  const rec = c.provider_id ? providersById.get(c.provider_id) : undefined;
  const effectiveModel = c.model || rec?.default_model || '';

  // Determine kind + endpoint from the record, else from the legacy enum + global config.
  let kind: string;
  let baseUrl = '';
  let apiKey = '';
  let providerLabel: string;
  if (rec) {
    kind = rec.kind;
    providerLabel = rec.name;
    baseUrl = resolveEnvVars(rec.base_url || '');
    apiKey = resolveEnvVars(rec.api_key || '');
  } else {
    const legacy = c.provider ?? 'unknown';
    providerLabel = legacy;
    if (legacy === 'openrouter') { kind = 'openai_compat'; baseUrl = 'https://openrouter.ai/api/v1'; apiKey = resolveEnvVars(config.models.openrouter.api_key || ''); }
    else if (legacy === 'local' || legacy === 'ollama') { kind = 'openai_compat'; baseUrl = config.models.local.base_url || ''; apiKey = resolveEnvVars(config.models.local.api_key || ''); }
    else { kind = legacy; }
  }

  let status: AgentStatus = 'ready';
  let latencyMs: number | undefined;
  let detail: string | undefined;

  if (kind === 'openai_compat') {
    const r = await probeLocalModels(baseUrl, apiKey);
    status = r.status;
    latencyMs = r.latencyMs;
    detail = baseUrl || 'no base_url';
  } else if (kind === 'hermes') {
    const r = await probeHermes(baseUrl);
    status = r.status;
    latencyMs = r.latencyMs;
    detail = r.detail;
  } else if (kind === 'claude_code' || kind === 'codex' || kind === 'opencode') {
    status = 'ready';
    detail = 'CLI';
  } else {
    status = effectiveModel ? 'ready' : 'offline';
  }

  return { slug: p.slug, name: p.name, provider: providerLabel, model: effectiveModel, status, latencyMs, detail };
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

    // Agent roster with per-provider health (resolving each persona's provider record).
    const providersById = new Map<string, Provider>(
      (db.prepare('SELECT id, name, kind, base_url, api_key, default_model, created_at FROM providers').all() as Provider[]).map(p => [p.id, p]),
    );
    const personas = db
      .prepare('SELECT id, name, slug, config_yaml FROM personas')
      .all() as PersonaRow[];
    const agents = await Promise.all(personas.map(p => probeAgent(p, config, providersById)));

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
