/**
 * Providers — first-class, testable harness endpoints.
 *
 * A provider is a configured way to reach a harness: a CLI (claude_code / codex)
 * or any OpenAI-compatible HTTP endpoint (openai_compat — OpenRouter, omlx, a
 * local llama server, …). Personas reference a provider by id. Seeded from the
 * existing config on first boot so nothing breaks.
 */
import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { spawn } from 'child_process';
import { Provider, ProviderKind } from '@nexus/shared';
import { loadConfig, resolveEnvVars } from '../config';
import { hermesHealthUrl } from '../orchestrator/providers';

const COLS = 'id, name, kind, base_url, api_key, default_model, models, args, created_at';

/** DB rows store `models` as a JSON string; parse it back into string[] for the API. */
function rowToProvider(row: any): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url ?? null,
    api_key: row.api_key ?? null,
    default_model: row.default_model ?? null,
    models: row.models ? JSON.parse(row.models) : [],
    args: row.args ?? null,
    created_at: row.created_at,
  };
}

/** Load a provider by id with all columns parsed (models/args included). */
export function getProviderById(db: Database.Database, id: string): Provider | undefined {
  const row = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id);
  return row ? rowToProvider(row) : undefined;
}

/**
 * Seed default providers, and backfill ones added in later versions.
 *
 * Fresh DB (empty table): seed the full default set, then stamp `user_version = 1`
 * so the OpenCode backfill below is considered satisfied. Existing DB: seeding is
 * skipped, but providers introduced after the initial seed are added once, gated on
 * `user_version`, so a user who later deletes one isn't fighting a re-add every boot.
 * Idempotent throughout: stable ids + INSERT OR IGNORE survive racing double-boots.
 */
/** Auto-provision the Hermes persona (stable id so racing boots can't duplicate). */
function seedHermesPersona(db: Database.Database): void {
  const yaml = [
    'name: Hermes',
    'slug: hermes',
    'provider: openrouter',
    'provider_id: seed-hermes',
    "model: ''",
    "system_prompt: 'You are Hermes, a remote scheduling/automation agent.'",
    'tools: []',
    "workspace: '~/Projects/{project}'",
    'startup_scripts: []',
    'token_budget: 4000',
  ].join('\n') + '\n';
  db.prepare('INSERT OR IGNORE INTO personas (id, name, slug, config_yaml, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('seed-hermes-persona', 'Hermes', 'hermes', yaml, new Date().toISOString());
}

export function seedProviders(db: Database.Database): void {
  const n = (db.prepare('SELECT COUNT(*) as n FROM providers').get() as { n: number }).n;
  const now = new Date().toISOString();
  const insSql = `INSERT OR IGNORE INTO providers (${COLS}) VALUES (@id, @name, @kind, @base_url, @api_key, @default_model, @models, @args, @created_at)`;
  // Shared by the fresh seed and the existing-DB backfill (single source of truth).
  const opencode = { id: 'seed-opencode', name: 'OpenCode', kind: 'opencode', base_url: null, api_key: null, default_model: null, models: JSON.stringify(['openrouter/anthropic/claude-sonnet-4.5']), args: null, created_at: now };
  const hermes = { id: 'seed-hermes', name: 'Hermes', kind: 'hermes', base_url: 'http://100.87.109.31:8642/v1', api_key: '${HERMES_API_KEY}', default_model: 'hermes-agent', models: JSON.stringify(['hermes-agent']), args: null, created_at: now };

  if (n === 0) {
    const config = loadConfig();
    const ins = db.prepare(insSql);
    const seed = [
      { id: 'seed-openrouter', name: 'OpenRouter', kind: 'openai_compat', base_url: 'https://openrouter.ai/api/v1', api_key: config.models.openrouter.api_key || null, default_model: 'anthropic/claude-sonnet-4', models: JSON.stringify([]), args: null, created_at: now },
      { id: 'seed-local', name: 'Local (omlx)', kind: 'openai_compat', base_url: config.models.local.base_url || 'http://127.0.0.1:4001/v1', api_key: config.models.local.api_key || null, default_model: null, models: JSON.stringify([]), args: null, created_at: now },
      { id: 'seed-claude-code', name: 'Claude Code', kind: 'claude_code', base_url: null, api_key: null, default_model: 'sonnet', models: JSON.stringify(['opus', 'sonnet', 'haiku', 'opus-4.5', 'sonnet-4.5', 'haiku-4']), args: null, created_at: now },
      { id: 'seed-codex', name: 'Codex', kind: 'codex', base_url: null, api_key: null, default_model: null, models: JSON.stringify(['gpt-5', 'gpt-5-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.2', 'gpt-5.2-codex', 'o3', 'o3-mini', 'o4-mini']), args: null, created_at: now },
      opencode,
      hermes,
    ];
    for (const p of seed) ins.run(p);
    console.log(`[providers] seeded ${seed.length} default providers`);
    seedHermesPersona(db);
    db.pragma('user_version = 2');
    return;
  }

  // Existing DB: one-time backfills, gated by user_version (each runs exactly once).
  const uv = db.pragma('user_version', { simple: true }) as number;
  if (uv >= 3) {
    // Even after the user_version migration is done, refresh stale model lists
    // so users get the latest Claude/Codex aliases without re-saving.
    refreshStaleModelLists(db);
    return;
  }
  const ins = db.prepare(insSql);
  if (uv < 1) {
    ins.run(opencode);
    console.log('[providers] backfilled OpenCode provider (one-time)');
  }
  if (uv < 2) {
    ins.run(hermes);
    seedHermesPersona(db);
    console.log('[providers] backfilled Hermes provider + persona (one-time)');
  }
  if (uv < 3) {
    refreshStaleModelLists(db);
    console.log('[providers] refreshed CLI provider model lists (one-time)');
  }
  db.pragma('user_version = 3');
}

/**
 * One-time refresh of stale model lists for Claude Code + Codex providers.
 * The original seed lists were incomplete (e.g. missing opus-4.5, gpt-5-codex).
 * Existing DBs keep their stored list if the user has customized it, but get
 * a fresh curated list if they're still on the original seed values.
 */
function refreshStaleModelLists(db: Database.Database): void {
  const up = db.prepare('UPDATE providers SET models = ? WHERE id = ? AND models = ?');
  const changes = [
    {
      id: 'seed-claude-code',
      current: JSON.stringify(['opus', 'sonnet', 'haiku']),
      next: JSON.stringify(['opus', 'sonnet', 'haiku', 'opus-4.5', 'sonnet-4.5', 'haiku-4']),
    },
    {
      id: 'seed-codex',
      current: JSON.stringify(['gpt-5.5', 'gpt-5.3-codex']),
      next: JSON.stringify(['gpt-5', 'gpt-5-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.2', 'gpt-5.2-codex', 'o3', 'o3-mini', 'o4-mini']),
    },
  ];
  for (const { id, current, next } of changes) {
    const r = up.run(next, id, current);
    if (r.changes > 0) {
      console.log(`[providers] refreshed model list for ${id}`);
    }
  }
}

/** Test connectivity: ping /models for HTTP providers, or run `--version` for CLIs. */
async function testProvider(p: Provider): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
  if (p.kind === 'hermes') {
    const url = hermesHealthUrl(resolveEnvVars(p.base_url || ''));
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const body: any = await res.json().catch(() => ({}));
      const ok = res.ok && body?.status === 'ok';
      return { ok, detail: ok ? (body.platform || 'ok') : `HTTP ${res.status}`, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { ok: false, detail: err.name === 'AbortError' ? 'timed out' : err.message };
    }
  }
  if (p.kind === 'openai_compat') {
    if (!p.base_url) return { ok: false, detail: 'No base URL configured' };
    const url = `${p.base_url.replace(/\/$/, '')}/models`;
    const apiKey = resolveEnvVars(p.api_key || '');
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: ctrl.signal });
      clearTimeout(timer);
      return { ok: res.ok, detail: `HTTP ${res.status}${res.ok ? '' : ' — ' + (await res.text()).slice(0, 80)}`, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { ok: false, detail: err.name === 'AbortError' ? 'timed out' : err.message };
    }
  }
  // CLI kinds — verify the binary runs.
  const config = loadConfig();
  const command = p.kind === 'claude_code' ? config.claude_code.command
    : p.kind === 'codex' ? config.codex.command
    : 'opencode';
  return new Promise(resolve => {
    const start = Date.now();
    let out = '';
    let settled = false;
    const done = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail, latencyMs: Date.now() - start });
    };
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', d => (out += d.toString()));
    child.on('close', code => done(code === 0, code === 0 ? out.trim().split('\n')[0] || 'ok' : `exited ${code}`));
    child.on('error', err => done(false, `${command}: ${err.message}`));
    const timer = setTimeout(() => { child.kill(); done(false, 'timed out'); }, 5000);
  });
}

export async function registerProviderRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/providers', async () => (db.prepare(`SELECT ${COLS} FROM providers ORDER BY name ASC`).all() as any[]).map(rowToProvider));

  fastify.post('/api/providers', async (request) => {
    const b = request.body as Partial<Provider>;
    const kind: ProviderKind =
      b.kind === 'claude_code' || b.kind === 'codex' || b.kind === 'opencode' ? b.kind : 'openai_compat';
    const row = {
      id: uuid(),
      name: b.name?.trim() || 'Unnamed provider',
      kind,
      base_url: b.base_url?.trim() || null,
      api_key: b.api_key?.trim() || null,
      default_model: b.default_model?.trim() || null,
      models: JSON.stringify(Array.isArray(b.models) ? b.models : []),
      args: (b.args ?? '').trim() || null,
      created_at: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO providers (${COLS}) VALUES (@id, @name, @kind, @base_url, @api_key, @default_model, @models, @args, @created_at)`).run(row);
    return rowToProvider(row);
  });

  fastify.put('/api/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as any;
    if (!existing) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    const b = request.body as Partial<Provider>;
    const row = {
      id,
      name: b.name?.trim() || existing.name,
      kind: b.kind ?? existing.kind,
      base_url: b.base_url !== undefined ? b.base_url || null : existing.base_url,
      api_key: b.api_key !== undefined ? b.api_key || null : existing.api_key,
      default_model: b.default_model !== undefined ? b.default_model || null : existing.default_model,
      models: b.models !== undefined ? JSON.stringify(Array.isArray(b.models) ? b.models : []) : existing.models,
      args: b.args !== undefined ? (b.args || null) : existing.args,
      created_at: existing.created_at,
    };
    db.prepare('UPDATE providers SET name=@name, kind=@kind, base_url=@base_url, api_key=@api_key, default_model=@default_model, models=@models, args=@args WHERE id=@id').run(row);
    return rowToProvider(row);
  });

  fastify.delete('/api/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return { success: true };
  });

  fastify.post('/api/providers/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as any;
    if (!row) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    return testProvider(rowToProvider(row));
  });

  /**
   * Discover available models for a provider.
   * - HTTP (openai_compat / hermes): hit {base_url}/models
   * - CLI (claude_code / codex): curated list of known models + best-effort CLI probing
   * - Returns: { models: string[] } — additive to the provider's stored list
   */
  fastify.get('/api/providers/:id/discover-models', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as any;
    if (!row) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    const p = rowToProvider(row);
    if (p.kind === 'claude_code') {
      return { models: discoverClaudeCodeModels() };
    }
    if (p.kind === 'codex') {
      return { models: discoverCodexModels() };
    }
    if (p.kind === 'openai_compat' || p.kind === 'hermes') {
      if (!p.base_url) { const e = new Error('No base URL configured') as any; e.statusCode = 400; throw e; }
      const url = `${p.base_url.replace(/\/$/, '')}/models`;
      const apiKey = resolveEnvVars(p.api_key || '');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) { const e = new Error(`HTTP ${res.status}`) as any; e.statusCode = 502; throw e; }
        const body: any = await res.json();
        const list: string[] = Array.isArray(body?.data)
          ? body.data.map((m: any) => m.id).filter((s: any) => typeof s === 'string')
          : Array.isArray(body)
            ? body.map((m: any) => m.id ?? m).filter((s: any) => typeof s === 'string')
            : [];
        return { models: list };
      } catch (err: any) {
        const e = new Error(err?.message || 'discover failed') as any; e.statusCode = 502; throw e;
      }
    }
    return { models: p.models };
  });
}

/**
 * Best-effort model discovery for Claude Code CLI. Tries `claude --list-models`
 * first (if the binary supports it); otherwise returns a curated list of the
 * known model aliases that the CLI accepts.
 */
function discoverClaudeCodeModels(): string[] {
  // Curated fallback — these are the aliases Claude Code CLI accepts as of 2026.
  // Kept in sync with the Claude Code release notes / docs.
  const curated = [
    'opus',
    'opus-4',
    'opus-4.1',
    'opus-4.5',
    'sonnet',
    'sonnet-4',
    'sonnet-4.5',
    'haiku',
    'haiku-3.5',
    'haiku-4',
  ];
  // Note: the Claude Code CLI doesn't currently expose a --list-models flag,
  // so we just return the curated list. Providers can curate further in the UI.
  return curated;
}

function discoverCodexModels(): string[] {
  const curated = [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-codex',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.2',
    'gpt-5.2-codex',
    'o3',
    'o3-mini',
    'o4-mini',
  ];
  return curated;
}
