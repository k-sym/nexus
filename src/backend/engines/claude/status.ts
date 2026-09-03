/**
 * Status helpers for the Claude engine: what `/api/engines` reports, and
 * whether Pi's Anthropic OAuth models should be hidden from the catalog.
 */
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { CLAUDE_CODE_MODELS } from './models.js';
import { interpolate, type ClaudeEngineConfig } from './auth.js';

export interface EngineStatus {
  id: 'claude-code';
  enabled: boolean;
  auth: 'subscription' | 'api_key';
  tokenConfigured: boolean;
  authSource: 'token' | 'login' | 'api_key';
  executablePath: string | null;
  modelCount: number;
  settingSources: string[];
  skills: 'all' | 'none' | string[];
}

const SETTING_SOURCES = new Set(['user', 'project', 'local']);

/** Filters `setting_sources` to the three known values and coerces `skills`
 *  to `'all' | 'none' | string[]` (default `'all'`), so a malformed or
 *  stale config value never reaches the SDK. */
export function normalizeClaudeEngineConfig(cfg: ClaudeEngineConfig): { settingSources: Array<'user' | 'project' | 'local'>; skills: 'all' | 'none' | string[] } {
  const settingSources = (Array.isArray(cfg.setting_sources) ? cfg.setting_sources : []).filter(
    (s): s is 'user' | 'project' | 'local' => typeof s === 'string' && SETTING_SOURCES.has(s),
  );
  const raw = cfg.skills as unknown;
  const skills = raw === 'none' ? 'none' : Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : 'all';
  return { settingSources, skills };
}

export function claudeEngineStatus(cfg: ClaudeEngineConfig, env: NodeJS.ProcessEnv = process.env): EngineStatus {
  const tokenConfigured = interpolate(cfg.oauth_token || '', env).trim().length > 0;
  return {
    id: 'claude-code',
    enabled: cfg.enabled === true,
    auth: cfg.auth === 'api_key' ? 'api_key' : 'subscription',
    tokenConfigured,
    authSource: cfg.auth === 'api_key' ? 'api_key' : tokenConfigured ? 'token' : 'login',
    executablePath: cfg.executable_path?.trim() || null,
    modelCount: CLAUDE_CODE_MODELS.length,
    ...normalizeClaudeEngineConfig(cfg),
  };
}

/** Pi's Anthropic OAuth path is the non-compliant one; hide it whenever the
 *  Claude engine is on. An API-key credential for `anthropic` is untouched. */
export function isPiAnthropicOAuthHidden(cfg: ClaudeEngineConfig, authFile: string): boolean {
  if (cfg.enabled !== true) return false;
  try {
    return readStoredCredential('anthropic', authFile)?.type === 'oauth';
  } catch {
    return false;
  }
}
