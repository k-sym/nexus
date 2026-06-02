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
import { Provider } from '@nexus/shared';
import { loadConfig, resolveEnvVars } from '../config';

const COLS = 'id, name, kind, base_url, api_key, default_model, created_at';

/**
 * Seed default providers from the existing config when the table is empty.
 * Idempotent: stable ids + INSERT OR IGNORE, so a racing double-boot (two tsx
 * reloads) can't create duplicates, and user-deleted seeds aren't recreated.
 */
export function seedProviders(db: Database.Database): void {
  const n = (db.prepare('SELECT COUNT(*) as n FROM providers').get() as { n: number }).n;
  if (n > 0) return;
  const config = loadConfig();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO providers (${COLS}) VALUES (@id, @name, @kind, @base_url, @api_key, @default_model, @created_at)`);
  const seed: Provider[] = [
    { id: 'seed-openrouter', name: 'OpenRouter', kind: 'openai_compat', base_url: 'https://openrouter.ai/api/v1', api_key: config.models.openrouter.api_key || null, default_model: 'anthropic/claude-sonnet-4', created_at: now },
    { id: 'seed-local', name: 'Local (omlx)', kind: 'openai_compat', base_url: config.models.local.base_url || 'http://127.0.0.1:4001/v1', api_key: config.models.local.api_key || null, default_model: null, created_at: now },
    { id: 'seed-claude-code', name: 'Claude Code', kind: 'claude_code', base_url: null, api_key: null, default_model: 'sonnet', created_at: now },
    { id: 'seed-codex', name: 'Codex', kind: 'codex', base_url: null, api_key: null, default_model: null, created_at: now },
  ];
  for (const p of seed) ins.run(p);
  console.log(`[providers] seeded ${seed.length} default providers`);
}

/** Test connectivity: ping /models for HTTP providers, or run `--version` for CLIs. */
async function testProvider(p: Provider): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
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
  const command = p.kind === 'claude_code' ? config.claude_code.command : config.codex.command;
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

  fastify.get('/api/providers', async () => db.prepare(`SELECT ${COLS} FROM providers ORDER BY name ASC`).all());

  fastify.post('/api/providers', async (request) => {
    const b = request.body as Partial<Provider>;
    const p: Provider = {
      id: uuid(),
      name: b.name?.trim() || 'Unnamed provider',
      kind: b.kind === 'claude_code' || b.kind === 'codex' ? b.kind : 'openai_compat',
      base_url: b.base_url?.trim() || null,
      api_key: b.api_key?.trim() || null,
      default_model: b.default_model?.trim() || null,
      created_at: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO providers (${COLS}) VALUES (@id, @name, @kind, @base_url, @api_key, @default_model, @created_at)`).run(p);
    return p;
  });

  fastify.put('/api/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as Provider | undefined;
    if (!existing) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    const b = request.body as Partial<Provider>;
    const merged: Provider = {
      ...existing,
      name: b.name?.trim() || existing.name,
      kind: b.kind ?? existing.kind,
      base_url: b.base_url !== undefined ? b.base_url || null : existing.base_url,
      api_key: b.api_key !== undefined ? b.api_key || null : existing.api_key,
      default_model: b.default_model !== undefined ? b.default_model || null : existing.default_model,
    };
    db.prepare('UPDATE providers SET name=@name, kind=@kind, base_url=@base_url, api_key=@api_key, default_model=@default_model WHERE id=@id').run(merged);
    return merged;
  });

  fastify.delete('/api/providers/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return { success: true };
  });

  fastify.post('/api/providers/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const p = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id) as Provider | undefined;
    if (!p) { const e = new Error('Provider not found') as any; e.statusCode = 404; throw e; }
    return testProvider(p);
  });
}
