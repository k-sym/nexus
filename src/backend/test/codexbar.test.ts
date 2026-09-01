import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUsageStats,
  parseCodexBarCost,
  parseCodexBarUsage,
  parseCodexUsageWindows,
  parseUsageHistory,
  resetUsageStatsCacheForTests,
} from '../codexbar';

const claudeCostPayload = JSON.stringify([{
  provider: 'claude',
  sessionCostUSD: 180.168446,
  last30DaysCostUSD: 2372.4355333,
  updatedAt: '2026-09-01T16:17:24Z',
  daily: [
    { date: '2026-08-31', totalCost: 41.02 },
    { date: '2026-09-01', totalCost: 23.4567 },
  ],
}]);

const sept1 = () => new Date('2026-09-01T12:00:00Z');

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
    source: 'codexbar-live',
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

test('parseCodexBarUsage maps current CodexBar session and weekly windows', () => {
  const stats = parseCodexBarUsage('claude', JSON.stringify([{
    provider: 'claude',
    source: 'web',
    usage: {
      updatedAt: '2026-07-16T10:04:11Z',
      primary: { usedPercent: 11, windowMinutes: 300, resetsAt: '2026-07-16T11:09:59Z' },
      secondary: { usedPercent: 2, windowMinutes: 10080, resetsAt: '2026-07-19T21:59:59Z' },
    },
  }]));

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '89%');
  assert.equal(stats.source, 'codexbar-web');
  assert.equal(stats.sampledAt, '2026-07-16T10:04:11Z');
  assert.equal(stats.windows?.session?.usedPercent, 11);
  assert.equal(stats.windows?.session?.windowMinutes, 300);
  assert.equal(stats.windows?.weekly?.usedPercent, 2);
  assert.equal(stats.windows?.weekly?.windowMinutes, 10080);
});

test('parseCodexBarUsage maps the current nested OpenRouter balance', () => {
  const stats = parseCodexBarUsage('openrouter', JSON.stringify([{
    provider: 'openrouter',
    source: 'api',
    usage: { updatedAt: '2026-07-16T10:04:37Z', openRouterUsage: { balance: 259.006181064 } },
  }]));

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '$259.01');
  assert.equal(stats.source, 'codexbar-api');
  assert.equal(stats.sampledAt, '2026-07-16T10:04:37Z');
});

test('parseCodexBarUsage maps the CodexBar 0.55 OpenRouter details rows', () => {
  const stats = parseCodexBarUsage('openrouter', JSON.stringify([{
    provider: 'openrouter',
    source: 'api',
    usage: {
      loginMethod: 'Balance: $373.78',
      updatedAt: '2026-08-26T17:09:24Z',
      details: [
        {
          title: 'Credits',
          rows: [
            { label: 'Remaining', value: '$373.78' },
            { label: 'Used', value: '$437.22' },
            { label: 'Total added', value: '$811.00' },
          ],
        },
        {
          title: 'API key',
          rows: [{ label: 'Today', value: '$3.52' }],
          chart: { unit: 'USD', kind: 'bars', title: 'Key spend', points: [{ value: 3.52291003, label: 'Today' }] },
        },
      ],
      primary: null,
      secondary: null,
    },
  }]));

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '$373.78');
  assert.equal(stats.caption, 'credit balance');
  assert.equal(stats.source, 'codexbar-api');
  assert.equal(stats.sampledAt, '2026-08-26T17:09:24Z');
});

test('parseCodexBarUsage falls back to the 0.55 loginMethod balance summary', () => {
  const stats = parseCodexBarUsage('openrouter', JSON.stringify([{
    provider: 'openrouter',
    source: 'api',
    usage: { loginMethod: 'Balance: $1,024.50', details: [] },
  }]));

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '$1024.50');
});

test('getUsageStats prefers current CodexBar CLI data for every dashboard provider', async () => {
  const payloads: Record<string, string> = {
    codex: JSON.stringify([{ provider: 'codex', source: 'oauth', usage: { secondary: { usedPercent: 9, windowMinutes: 10080 } } }]),
    openrouter: JSON.stringify([{ provider: 'openrouter', source: 'api', usage: { openRouterUsage: { balance: 259.006 } } }]),
  };
  const stats = await getUsageStats({
    codexBarUsage: async (provider) => payloads[provider],
    codexBarCost: async () => claudeCostPayload,
    codexUsage: async () => { throw new Error('should not use Codex fallback'); },
    openRouterBalance: async () => { throw new Error('should not use OpenRouter fallback'); },
  });

  assert.equal(stats.claude.value, '$180.17');
  assert.equal(stats.claude.source, 'codexbar-cost');
  assert.equal(stats.codex.value, '91%');
  assert.equal(stats.openrouter.value, '$259.01');
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

test('parseCodexBarCost maps session, today, and 30 day cost totals', () => {
  const stats = parseCodexBarCost(claudeCostPayload, sept1);

  assert.equal(stats.ok, true);
  assert.equal(stats.provider, 'claude');
  assert.equal(stats.value, '$180.17');
  assert.equal(stats.caption, 'session cost · $23.46 today · $2,372 last 30 days');
  assert.equal(stats.source, 'codexbar-cost');
  assert.equal(stats.sampledAt, '2026-09-01T16:17:24Z');
});

test('parseCodexBarCost falls back to daily totals without an active session', () => {
  const stats = parseCodexBarCost(
    JSON.stringify([{ provider: 'claude', last30DaysCostUSD: 89.5, daily: [{ date: '2026-09-01', totalCost: 4.2 }] }]),
    sept1,
  );

  assert.equal(stats.ok, true);
  assert.equal(stats.value, '$4.20');
  assert.equal(stats.caption, 'cost today · $89.50 last 30 days');
});

test('parseCodexBarCost preserves provider errors without throwing', () => {
  const stats = parseCodexBarCost(
    JSON.stringify([{ provider: 'claude', error: { message: 'No local Claude logs found' } }]),
    sept1,
  );

  assert.equal(stats.ok, false);
  assert.equal(stats.caption, 'local cost unavailable');
  assert.equal(stats.error, 'No local Claude logs found');
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

test('getUsageStats reads Claude cost data from the CodexBar cost CLI', async () => {
  const stats = await getUsageStats({
    readHistory: async () => '',
    codexBarCost: async () => claudeCostPayload,
    codexUsage: async () => ({
      rate_limit: {
        primary_window: { used_percent: 29, limit_window_seconds: 18_000, reset_at: '2026-06-11T03:32:00Z' },
      },
    }),
    openRouterBalance: async () => ({ balance: 12.34, currency: 'USD' }),
  });

  assert.equal(stats.claude.ok, true);
  assert.equal(stats.claude.source, 'codexbar-cost');
  assert.equal(stats.claude.value, '$180.17');
  assert.equal(stats.claude.sampledAt, '2026-09-01T16:17:24Z');
});

test('getUsageStats hides local paths when the CodexBar cost CLI is missing', async () => {
  const missingCli = Object.assign(
    new Error("ENOENT: no such file or directory, spawn '/Users/example/bin/codexbar'"),
    { code: 'ENOENT' },
  );
  const stats = await getUsageStats({
    readHistory: async () => '',
    codexBarCost: async () => { throw missingCli; },
    codexUsage: async () => { throw new Error('Codex credentials unavailable'); },
    openRouterBalance: async () => null,
  });

  assert.equal(stats.claude.ok, false);
  assert.equal(stats.claude.caption, 'local cost unavailable');
  assert.equal(stats.claude.error, 'CodexBar CLI not found');
  assert.doesNotMatch(stats.claude.error || '', /Users|ENOENT/);
});

test('getUsageStats reuses cached provider stats for 300 seconds', async () => {
  resetUsageStatsCacheForTests();
  let openRouterCalls = 0;

  const baseOptions = {
    useCache: true,
    readHistory: async () => '',
    codexBarCost: async () => JSON.stringify([{ provider: 'claude', sessionCostUSD: 1.5, last30DaysCostUSD: 10 }]),
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
    codexBarCost: async () => JSON.stringify([{ provider: 'claude', sessionCostUSD: 1.5, last30DaysCostUSD: 10 }]),
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
