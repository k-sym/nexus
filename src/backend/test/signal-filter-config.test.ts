import assert from 'node:assert/strict';
import test from 'node:test';
import type { NexusConfig } from '@nexus/shared';
import {
  DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
  normalizeSignalFilterProjectPath,
  resolveSignalFilterConfig,
} from '../signal-filters/config';

function configWith(overrides: Record<string, unknown> = {}): NexusConfig {
  return {
    signal_filters: {
      ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
      projects: {
        '/tmp/noisy': { max_output_bytes: 8000, filters: { stack_trace: false } },
        '/tmp/off': { enabled: false },
      },
      ...overrides,
    },
  } as NexusConfig;
}

test('resolveSignalFilterConfig deep-merges the matching project override', () => {
  const resolved = resolveSignalFilterConfig(configWith(), '/tmp/noisy/');
  assert.equal(resolved.max_output_bytes, 8000);
  assert.equal(resolved.filters.stack_trace, false);
  assert.equal(resolved.filters.test_output, true);
});

test('resolveSignalFilterConfig supports a disabled project', () => {
  assert.equal(resolveSignalFilterConfig(configWith(), '/tmp/off').enabled, false);
});

test('resolveSignalFilterConfig replaces invalid numeric values with defaults', () => {
  const resolved = resolveSignalFilterConfig(
    configWith({ min_input_bytes: -1, max_output_bytes: Number.NaN }),
    '/tmp/other',
  );
  assert.equal(resolved.min_input_bytes, 4096);
  assert.equal(resolved.max_output_bytes, 12000);
});

test('normalizeSignalFilterProjectPath expands home and removes trailing separators', () => {
  assert.equal(normalizeSignalFilterProjectPath('/tmp/repo///'), '/tmp/repo');
  assert.equal(normalizeSignalFilterProjectPath('~/repo').endsWith('/repo'), true);
});
