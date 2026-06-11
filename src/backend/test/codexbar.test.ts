import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUsageStats,
  parseClaudeOAuthUsage,
  parseClaudeStatuslineCache,
  parseCodexBarUsage,
  parseCodexUsageWindows,
  parseUsageHistory,
  resetUsageStatsCacheForTests,
} from '../codexbar';

test('parseCodexBarUsage maps session remaining from used percent', () => {
  const stats = parseCodexBarUsage(
    'codex',
    JSON.stringify([{ provider: 'codex', usedPercent: 83, resetsAt: '2026-06-11T06:40:00Z', source: 'live' }]),
  );

  assert.deepEqual(stats, {
    ok: true,
    provider: 'codex',
    value: '17%',
    caption: 'remaining · resets 11 Jun, 06:40',
    source: 'live',
    sampledAt: undefined,
  });
});

test('parseCodexBarUsage maps OpenRouter credit balance', () => {
  const stats = parseCodexBarUsage(
    'openrouter',
    JSON.stringify([{ provider: 'openrouter', balance: 12.345, currency: 'USD', source: 'live' }]),
  );

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '$12.35');
  assert.equal(stats.caption, 'credit balance');
});

test('parseCodexBarUsage preserves provider errors without throwing', () => {
  const stats = parseCodexBarUsage(
    'claude',
    JSON.stringify([{ provider: 'claude', error: { message: 'Network unavailable' }, source: 'auto' }]),
  );

  assert.equal(stats.ok, false);
  assert.equal(stats.value, '—');
  assert.equal(stats.error, 'Network unavailable');
});

test('parseUsageHistory uses the latest matching provider sample', () => {
  const history = [
    JSON.stringify({ provider: 'codex', usedPercent: 20, sampledAt: '2026-06-10T10:00:00Z', resetsAt: '2026-06-11T00:00:00Z' }),
    JSON.stringify({ provider: 'codex', usedPercent: 83, sampledAt: '2026-06-10T21:51:38Z', resetsAt: '2026-06-11T06:40:00Z' }),
  ].join('\n');

  const stats = parseUsageHistory('codex', history);

  assert.equal(stats?.ok, true);
  assert.equal(stats?.value, '17%');
  assert.equal(stats?.source, 'history-cache');
});

test('getUsageStats reads Codex from history without invoking CodexBar', async () => {
  const history = [
    JSON.stringify({ provider: 'codex', usedPercent: 0, sampledAt: '2026-06-11T07:05:43Z', resetsAt: '2026-06-18T07:05:00Z' }),
  ].join('\n');

  const stats = await getUsageStats({
    readHistory: async () => history,
    codexUsage: async () => {
      throw new Error('force history fallback');
    },
    openRouterBalance: async () => ({ balance: 12.34, currency: 'USD' }),
  });

  assert.equal(stats.codex.ok, true);
  assert.equal(stats.codex.value, '100%');
  assert.equal(stats.codex.source, 'history-cache');
  assert.equal(stats.openrouter.value, '$12.34');
});

test('parseClaudeStatuslineCache maps cached five hour utilization', () => {
  const stats = parseClaudeStatuslineCache([
    'UTILIZATION=37',
    'RESETS_AT=2026-06-11T14:00:00Z',
    'TIMESTAMP=1781181600',
    'WEEKLY_UTILIZATION=54',
  ].join('\n'));

  assert.equal(stats.ok, true);
  assert.equal(stats.provider, 'claude');
  assert.equal(stats.value, '63%');
  assert.equal(stats.caption, 'session remaining · resets 11 Jun, 14:00');
  assert.equal(stats.source, 'claude-statusline-cache');
});

test('parseClaudeStatuslineCache maps session and weekly windows', () => {
  const stats = parseClaudeStatuslineCache([
    'UTILIZATION=0',
    'RESETS_AT=2026-06-11T02:00:00Z',
    'TIMESTAMP=1781181600',
    'WEEKLY_UTILIZATION=12',
    'WEEKLY_RESETS_AT=2026-06-14T23:00:00Z',
  ].join('\n'));

  assert.equal(stats.windows?.session?.usedPercent, 0);
  assert.equal(stats.windows?.session?.remainingPercent, 100);
  assert.equal(stats.windows?.session?.resetLabel, '11 Jun, 02:00');
  assert.equal(stats.windows?.weekly?.usedPercent, 12);
  assert.equal(stats.windows?.weekly?.remainingPercent, 88);
  assert.equal(stats.windows?.weekly?.resetLabel, '14 Jun, 23:00');
});

test('parseClaudeOAuthUsage maps five hour and seven day windows', () => {
  const stats = parseClaudeOAuthUsage({
    five_hour: { utilization: 5, resets_at: '2026-06-11T11:29:59.711952+00:00' },
    seven_day: { utilization: 12, resets_at: '2026-06-14T21:59:59.711978+00:00' },
  });

  assert.equal(stats.ok, true);
  assert.equal(stats.provider, 'claude');
  assert.equal(stats.value, '95%');
  assert.equal(stats.caption, 'session remaining · resets 11 Jun, 11:29');
  assert.equal(stats.source, 'anthropic-oauth-usage');
  assert.equal(stats.windows?.session?.usedPercent, 5);
  assert.equal(stats.windows?.session?.windowMinutes, 300);
  assert.equal(stats.windows?.weekly?.usedPercent, 12);
  assert.equal(stats.windows?.weekly?.windowMinutes, 10080);
});

test('parseCodexUsageWindows maps primary and secondary windows', () => {
  const stats = parseCodexUsageWindows({
    rate_limit: {
      primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: '2026-06-11T03:32:00Z' },
      secondary_window: { used_percent: 87, limit_window_seconds: 604800, reset_at: '2026-06-11T07:38:00Z' },
    },
  });

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '45%');
  assert.equal(stats.caption, 'session remaining · resets 11 Jun, 03:32');
  assert.equal(stats.windows?.session?.usedPercent, 55);
  assert.equal(stats.windows?.session?.windowMinutes, 300);
  assert.equal(stats.windows?.weekly?.usedPercent, 87);
  assert.equal(stats.windows?.weekly?.windowMinutes, 10080);
});

test('getUsageStats prefers live Codex windows over weekly history', async () => {
  const stats = await getUsageStats({
    readHistory: async () => JSON.stringify({ provider: 'codex', usedPercent: 3, sampledAt: '2026-06-11T07:00:00Z', resetsAt: '2026-06-18T07:00:00Z' }),
    readClaudeStatuslineCache: async () => 'UTILIZATION=1\nRESETS_AT=2026-06-11T02:00:00Z',
    codexUsage: async () => ({
      rate_limit: {
        primary_window: { used_percent: 19, limit_window_seconds: 18000, reset_at: 1781179418 },
        secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: 1781766218 },
      },
    }),
    openRouterBalance: async () => ({ balance: 12.34, currency: 'USD' }),
  });

  assert.equal(stats.codex.source, 'codex-web');
  assert.equal(stats.codex.windows?.session?.usedPercent, 19);
  assert.equal(stats.codex.windows?.weekly?.usedPercent, 3);
});

test('getUsageStats prefers live Claude OAuth usage over stale statusline cache', async () => {
  const stats = await getUsageStats({
    readHistory: async () => '',
    readClaudeStatuslineCache: async () => 'UTILIZATION=0\nRESETS_AT=2026-04-20T14:00:00Z\nWEEKLY_UTILIZATION=3',
    claudeUsage: async () => ({
      five_hour: { utilization: 5, resets_at: '2026-06-11T11:29:59.711952+00:00' },
      seven_day: { utilization: 12, resets_at: '2026-06-14T21:59:59.711978+00:00' },
    }),
    codexUsage: async () => ({
      rate_limit: {
        primary_window: { used_percent: 29, limit_window_seconds: 18_000, reset_at: '2026-06-11T03:32:00Z' },
      },
    }),
    openRouterBalance: async () => ({ balance: 12.34, currency: 'USD' }),
  });

  assert.equal(stats.claude.source, 'anthropic-oauth-usage');
  assert.equal(stats.claude.windows?.session?.usedPercent, 5);
  assert.equal(stats.claude.windows?.weekly?.usedPercent, 12);
});

test('getUsageStats reuses cached provider stats for 300 seconds', async () => {
  resetUsageStatsCacheForTests();
  let openRouterCalls = 0;

  const baseOptions = {
    useCache: true,
    readHistory: async () => '',
    readClaudeStatuslineCache: async () => 'UTILIZATION=4\nRESETS_AT=2026-06-11T02:00:00Z\nWEEKLY_UTILIZATION=12',
    codexUsage: async () => ({
      rate_limit: {
        primary_window: { used_percent: 29, limit_window_seconds: 18_000, reset_at: '2026-06-11T03:32:00Z' },
      },
    }),
    openRouterBalance: async () => {
      openRouterCalls += 1;
      return { balance: 12.34, currency: 'USD' };
    },
  };

  const first = await getUsageStats({ ...baseOptions, now: () => 1_000 });
  const second = await getUsageStats({ ...baseOptions, now: () => 300_999 });

  assert.equal(first, second);
  assert.equal(first.claude.sampledAt, '1970-01-01T00:00:01.000Z');
  assert.equal(first.codex.sampledAt, '1970-01-01T00:00:01.000Z');
  assert.equal(first.openrouter.sampledAt, '1970-01-01T00:00:01.000Z');
  assert.equal(openRouterCalls, 1);
});

test('getUsageStats refreshes after 300 seconds and preserves last good provider stats on failure', async () => {
  resetUsageStatsCacheForTests();
  let openRouterCalls = 0;

  const baseOptions = {
    useCache: true,
    readHistory: async () => '',
    readClaudeStatuslineCache: async () => 'UTILIZATION=4\nRESETS_AT=2026-06-11T02:00:00Z\nWEEKLY_UTILIZATION=12',
    codexUsage: async () => ({
      rate_limit: {
        primary_window: { used_percent: 29, limit_window_seconds: 18_000, reset_at: '2026-06-11T03:32:00Z' },
      },
    }),
    openRouterBalance: async () => {
      openRouterCalls += 1;
      if (openRouterCalls === 2) throw new Error('temporary OpenRouter failure');
      return { balance: 12.34, currency: 'USD' };
    },
  };

  await getUsageStats({ ...baseOptions, now: () => 1_000 });
  const refreshed = await getUsageStats({ ...baseOptions, now: () => 301_001 });

  assert.equal(openRouterCalls, 2);
  assert.equal(refreshed.openrouter.ok, true);
  assert.equal(refreshed.openrouter.value, '$12.34');
  assert.equal(refreshed.openrouter.error, 'temporary OpenRouter failure');
});
