import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, resolveOpenRouterKey } from './config.js';

export type CodexBarProvider = 'claude' | 'codex' | 'openrouter';

export interface CodexBarProviderStats {
  ok: boolean;
  provider: CodexBarProvider;
  value: string;
  caption: string;
  windows?: Partial<Record<'session' | 'weekly', UsageWindowStats>>;
  source?: string;
  sampledAt?: string;
  error?: string;
}

export type CodexBarStats = Record<CodexBarProvider, CodexBarProviderStats>;

export interface UsageWindowStats {
  usedPercent: number;
  remainingPercent: number;
  resetLabel?: string;
  resetsAt?: string;
  windowMinutes?: number;
}

const PROVIDERS: CodexBarProvider[] = ['claude', 'codex', 'openrouter'];
const DEFAULT_HISTORY_PATH = join(homedir(), 'Library', 'Application Support', 'CodexBar', 'usage-history.jsonl');
const DEFAULT_CLAUDE_STATUSLINE_CACHE_PATH = join(homedir(), '.claude', '.statusline-usage-cache');
const DEFAULT_CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const USAGE_POLL_MS = 300_000;
const OPENROUTER_TIMEOUT_MS = 4_000;
const CODEX_TIMEOUT_MS = 4_000;
const CLAUDE_TIMEOUT_MS = 4_000;
const execFileAsync = promisify(execFile);

let cached: { expiresAt: number; stats: CodexBarStats } | null = null;

export function resetUsageStatsCacheForTests() {
  cached = null;
}

function unavailable(provider: CodexBarProvider, error?: string): CodexBarProviderStats {
  return {
    ok: false,
    provider,
    value: '—',
    caption: provider === 'openrouter' ? 'credit balance unavailable' : 'session unavailable',
    error,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function firstObject(provider: CodexBarProvider, payload: unknown): Record<string, any> | null {
  for (const item of asArray(payload)) {
    if (item && typeof item === 'object') {
      const row = item as Record<string, any>;
      if (!row.provider || row.provider === provider) return row;
    }
  }
  return null;
}

function findNumber(value: unknown, names: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  for (const name of names) {
    const candidate = row[name];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim() !== '' && Number.isFinite(Number(candidate))) return Number(candidate);
  }
  for (const child of Object.values(row)) {
    const found = findNumber(child, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findString(value: unknown, names: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  for (const name of names) {
    const candidate = row[name];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  for (const child of Object.values(row)) {
    const found = findString(child, names);
    if (found) return found;
  }
  return undefined;
}

function resetDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000);
  if (typeof value !== 'string' || !value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value) ? new Date(numeric * 1000) : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date;
}

function formatReset(value: unknown): string | null {
  const date = resetDate(value);
  if (!date) return null;
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month}, ${hour}:${minute}`;
}

function isoReset(value: unknown): string | undefined {
  return resetDate(value)?.toISOString();
}

function usageWindow(usedPercent: unknown, reset: unknown, windowSeconds?: unknown): UsageWindowStats | null {
  const used = Number(usedPercent);
  if (!Number.isFinite(used)) return null;
  const roundedUsed = Math.round(Math.max(0, used));
  const remaining = Math.max(0, Math.min(100, 100 - roundedUsed));
  const minutes = Number(windowSeconds);
  return {
    usedPercent: roundedUsed,
    remainingPercent: remaining,
    resetLabel: formatReset(reset) ?? undefined,
    resetsAt: isoReset(reset),
    windowMinutes: Number.isFinite(minutes) ? Math.round(minutes / 60) : undefined,
  };
}

function captionForWindow(kind: 'session' | 'weekly', window?: UsageWindowStats): string {
  const label = kind === 'session' ? 'session' : 'weekly';
  return window?.resetLabel ? `${label} remaining · resets ${window.resetLabel}` : `${label} remaining`;
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty codexbar response');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = Math.min(
      ...['[', '{'].map((needle) => {
        const index = trimmed.indexOf(needle);
        return index === -1 ? Number.POSITIVE_INFINITY : index;
      }),
    );
    if (!Number.isFinite(start)) throw new Error('codexbar response did not contain JSON');
    return JSON.parse(trimmed.slice(start));
  }
}

export function parseCodexBarUsage(provider: CodexBarProvider, stdout: string): CodexBarProviderStats {
  const payload = parseJsonPayload(stdout);
  const row = firstObject(provider, payload);
  if (!row) return unavailable(provider, 'No provider stats returned');

  const source = typeof row.source === 'string' ? row.source : undefined;
  const sampledAt = typeof row.sampledAt === 'string' ? row.sampledAt : undefined;
  if (row.error) {
    const message = typeof row.error === 'string' ? row.error : row.error.message;
    return { ...unavailable(provider, message || 'CodexBar provider error'), source, sampledAt };
  }

  if (provider === 'openrouter') {
    const balance = findNumber(row, ['balance', 'credits', 'creditBalance', 'creditsRemaining', 'remainingCredits']);
    if (balance !== undefined) {
      const currency = findString(row, ['currency']) || 'USD';
      const prefix = currency.toUpperCase() === 'USD' ? '$' : `${currency.toUpperCase()} `;
      return { ok: true, provider, value: `${prefix}${balance.toFixed(2)}`, caption: 'credit balance', source, sampledAt };
    }
  }

  const remaining =
    findNumber(row, ['remainingPercent', 'percentRemaining', 'availablePercent']) ??
    (() => {
      const used = findNumber(row, ['usedPercent', 'percentUsed']);
      return used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used));
    })();
  if (remaining !== undefined) {
    const reset = formatReset(row.resetsAt ?? row.resetAt ?? findString(row, ['resetsAt', 'resetAt']));
    return {
      ok: true,
      provider,
      value: `${Math.round(remaining)}%`,
      caption: reset ? `remaining · resets ${reset}` : 'remaining',
      source,
      sampledAt,
    };
  }

  return unavailable(provider, 'CodexBar returned an unsupported stats shape');
}

function parseKeyValueCache(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split(/\n/)) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) parsed[key] = value;
  }
  return parsed;
}

export function parseClaudeStatuslineCache(text: string): CodexBarProviderStats {
  const cache = parseKeyValueCache(text);
  const session = usageWindow(cache.UTILIZATION, cache.RESETS_AT, 18_000);
  if (!session) return unavailable('claude', 'Claude statusline cache missing UTILIZATION');
  const weekly = usageWindow(cache.WEEKLY_UTILIZATION, cache.WEEKLY_RESETS_AT, 604_800) ?? undefined;
  const sampledAt = cache.TIMESTAMP && Number.isFinite(Number(cache.TIMESTAMP))
    ? new Date(Number(cache.TIMESTAMP) * 1000).toISOString()
    : undefined;

  return {
    ok: true,
    provider: 'claude',
    value: `${session.remainingPercent}%`,
    caption: captionForWindow('session', session),
    windows: { session, weekly },
    source: 'claude-statusline-cache',
    sampledAt,
  };
}

export function parseClaudeOAuthUsage(payload: unknown): CodexBarProviderStats {
  const row = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const fiveHour = row.five_hour && typeof row.five_hour === 'object' ? row.five_hour as Record<string, any> : null;
  const sevenDay = row.seven_day && typeof row.seven_day === 'object' ? row.seven_day as Record<string, any> : null;
  const session = fiveHour ? usageWindow(fiveHour.utilization, fiveHour.resets_at ?? fiveHour.resetsAt, 18_000) : null;
  const weekly = sevenDay ? usageWindow(sevenDay.utilization, sevenDay.resets_at ?? sevenDay.resetsAt, 604_800) : null;

  if (!session && !weekly) return unavailable('claude', 'Claude OAuth usage response missing usage windows');
  const primaryWindow = session ?? weekly!;
  return {
    ok: true,
    provider: 'claude',
    value: `${primaryWindow.remainingPercent}%`,
    caption: captionForWindow(session ? 'session' : 'weekly', primaryWindow),
    windows: { session: session ?? undefined, weekly: weekly ?? undefined },
    source: 'anthropic-oauth-usage',
  };
}

export function parseCodexUsageWindows(payload: unknown): CodexBarProviderStats {
  const row = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const rateLimit = row.rate_limit && typeof row.rate_limit === 'object' ? row.rate_limit as Record<string, any> : row;
  const primary = rateLimit.primary_window && typeof rateLimit.primary_window === 'object' ? rateLimit.primary_window as Record<string, any> : null;
  const secondary = rateLimit.secondary_window && typeof rateLimit.secondary_window === 'object' ? rateLimit.secondary_window as Record<string, any> : null;
  const session = primary ? usageWindow(primary.used_percent ?? primary.usedPercent, primary.reset_at ?? primary.resetAt, primary.limit_window_seconds ?? primary.limitWindowSeconds) : null;
  const weekly = secondary ? usageWindow(secondary.used_percent ?? secondary.usedPercent, secondary.reset_at ?? secondary.resetAt, secondary.limit_window_seconds ?? secondary.limitWindowSeconds) : null;

  if (!session && !weekly) return unavailable('codex', 'Codex usage response missing usage windows');
  const primaryWindow = session ?? weekly!;
  return {
    ok: true,
    provider: 'codex',
    value: `${primaryWindow.remainingPercent}%`,
    caption: captionForWindow(session ? 'session' : 'weekly', primaryWindow),
    windows: { session: session ?? undefined, weekly: weekly ?? undefined },
    source: 'codex-web',
  };
}

export function parseCodexBarHistory(provider: CodexBarProvider, historyJsonl: string): CodexBarProviderStats | null {
  const rows = historyJsonl
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row): row is Record<string, any> => Boolean(row && row.provider === provider))
    .sort((left, right) => String(left.sampledAt ?? '').localeCompare(String(right.sampledAt ?? '')));

  const latest = rows.at(-1);
  if (!latest) return null;
  const parsed = parseCodexBarUsage(provider, JSON.stringify([{ ...latest, source: 'history-cache' }]));
  const kind = latest.windowKind === 'primary' || latest.windowMinutes === 300 ? 'session' : 'weekly';
  const window = usageWindow(latest.usedPercent ?? latest.percentUsed, latest.resetsAt ?? latest.resetAt, latest.windowMinutes ? Number(latest.windowMinutes) * 60 : undefined);
  return parsed.ok ? { ...parsed, windows: window ? { [kind]: window } : undefined, source: 'history-cache' } : null;
}

export const parseUsageHistory = parseCodexBarHistory;

async function readHistoryFallback(provider: CodexBarProvider, readHistory: () => Promise<string>): Promise<CodexBarProviderStats | null> {
  try {
    return parseCodexBarHistory(provider, await readHistory());
  } catch {
    return null;
  }
}

interface OpenRouterBalance {
  balance: number;
  currency?: string;
}

export interface UsageStatsOptions {
  useCache?: boolean;
  now?: () => number;
  readHistory?: () => Promise<string>;
  readClaudeStatuslineCache?: () => Promise<string>;
  readClaudeCredentials?: () => Promise<string>;
  readCodexAuth?: () => Promise<string>;
  claudeUsage?: () => Promise<unknown>;
  codexUsage?: () => Promise<unknown>;
  openRouterKey?: string;
  openRouterBalance?: () => Promise<OpenRouterBalance | null>;
}

function defaultReadHistory(): Promise<string> {
  return readFile(DEFAULT_HISTORY_PATH, 'utf8');
}

function defaultReadClaudeStatuslineCache(): Promise<string> {
  return readFile(DEFAULT_CLAUDE_STATUSLINE_CACHE_PATH, 'utf8');
}

async function defaultReadClaudeCredentials(): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 3_000 });
  return stdout.trim();
}

function defaultReadCodexAuth(): Promise<string> {
  return readFile(DEFAULT_CODEX_AUTH_PATH, 'utf8');
}

function formatOpenRouterBalance(balance: OpenRouterBalance): CodexBarProviderStats {
  const currency = balance.currency || 'USD';
  const prefix = currency.toUpperCase() === 'USD' ? '$' : `${currency.toUpperCase()} `;
  return { ok: true, provider: 'openrouter', value: `${prefix}${balance.balance.toFixed(2)}`, caption: 'credit balance', source: 'openrouter-api' };
}

function sampled(stats: CodexBarProviderStats, sampledAt: string): CodexBarProviderStats {
  return stats.ok ? { ...stats, sampledAt } : stats;
}

function parseOpenRouterCredits(payload: unknown): OpenRouterBalance | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, any>;
  const data = row.data && typeof row.data === 'object' ? row.data : row;
  const balance = findNumber(data, ['balance', 'credits', 'creditBalance', 'creditsRemaining', 'remainingCredits']);
  if (balance !== undefined) return { balance, currency: findString(data, ['currency']) || 'USD' };

  const totalCredits = findNumber(data, ['total_credits', 'totalCredits']);
  const totalUsage = findNumber(data, ['total_usage', 'totalUsage']);
  if (totalCredits !== undefined && totalUsage !== undefined) {
    return { balance: totalCredits - totalUsage, currency: findString(data, ['currency']) || 'USD' };
  }

  return null;
}

async function fetchOpenRouterBalance(key: string): Promise<OpenRouterBalance | null> {
  if (!key) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
    return parseOpenRouterCredits(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCodexUsage(readCodexAuth: () => Promise<string>): Promise<unknown> {
  const auth = JSON.parse(await readCodexAuth()) as { tokens?: { access_token?: string } };
  const token = auth.tokens?.access_token;
  if (!token) throw new Error('Codex auth token missing');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_TIMEOUT_MS);
  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Codex usage returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClaudeUsage(readClaudeCredentials: () => Promise<string>): Promise<unknown> {
  const credentials = JSON.parse(await readClaudeCredentials()) as { claudeAiOauth?: { accessToken?: string } };
  const token = credentials.claudeAiOauth?.accessToken;
  if (!token) throw new Error('Claude OAuth access token missing');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Claude OAuth usage returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function getUsageStats(options: UsageStatsOptions = {}): Promise<CodexBarStats> {
  const now = options.now?.() ?? Date.now();
  const sampledAt = new Date(now).toISOString();
  const useCache = options.useCache ?? Object.keys(options).length === 0;
  if (useCache && cached && cached.expiresAt > now) return cached.stats;

  const readHistory = options.readHistory ?? defaultReadHistory;
  const readClaudeStatuslineCache = options.readClaudeStatuslineCache ?? defaultReadClaudeStatuslineCache;
  const readClaudeCredentials = options.readClaudeCredentials ?? defaultReadClaudeCredentials;
  const readCodexAuth = options.readCodexAuth ?? defaultReadCodexAuth;
  const claudeUsage = options.claudeUsage ?? (() => fetchClaudeUsage(readClaudeCredentials));
  const codexUsage = options.codexUsage ?? (() => fetchCodexUsage(readCodexAuth));
  const openRouterKey = options.openRouterKey ?? resolveOpenRouterKey(loadConfig());
  const openRouterBalance = options.openRouterBalance ?? (() => fetchOpenRouterBalance(openRouterKey));

  const entries = await Promise.all(PROVIDERS.map(async (provider) => {
    if (provider === 'openrouter') {
      try {
        const balance = await openRouterBalance();
        if (balance) return [provider, sampled(formatOpenRouterBalance(balance), sampledAt)] as const;
      } catch (err: any) {
        return [provider, unavailable(provider, err?.message || 'OpenRouter unavailable')] as const;
      }
    }

    if (provider === 'claude') {
      try {
        const live = sampled(parseClaudeOAuthUsage(await claudeUsage()), sampledAt);
        if (live.ok) return [provider, live] as const;
      } catch {
        // Fall back to cached history/statusline sources below.
      }
    }

    if (provider === 'codex') {
      try {
        const live = sampled(parseCodexUsageWindows(await codexUsage()), sampledAt);
        if (live.ok) return [provider, live] as const;
      } catch {
        // Fall back to cached weekly history below.
      }
    }

    const history = await readHistoryFallback(provider, readHistory);
    if (history) return [provider, sampled(history, sampledAt)] as const;
    if (provider === 'claude') {
      try {
        return [provider, sampled(parseClaudeStatuslineCache(await readClaudeStatuslineCache()), sampledAt)] as const;
      } catch (err: any) {
        return [provider, unavailable(provider, err?.message || 'No Claude statusline cache')] as const;
      }
    }
    return [provider, unavailable(provider, 'No cached usage history')] as const;
  }));
  const freshStats = Object.fromEntries(entries) as CodexBarStats;
  const stats = useCache && cached
    ? Object.fromEntries(PROVIDERS.map((provider) => {
        const fresh = freshStats[provider];
        const previous = cached?.stats[provider];
        if (!fresh.ok && previous?.ok) return [provider, { ...previous, error: fresh.error }];
        return [provider, fresh];
      })) as CodexBarStats
    : freshStats;
  if (useCache) cached = { expiresAt: now + USAGE_POLL_MS, stats };
  return stats;
}
