import os from 'node:os';
import path from 'node:path';
import type { NexusConfig, SignalFilterFlags } from '@nexus/shared';

export interface ResolvedSignalFilterConfig {
  enabled: boolean;
  min_input_bytes: number;
  max_output_bytes: number;
  filters: SignalFilterFlags;
}

export const DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG: ResolvedSignalFilterConfig = {
  enabled: true,
  min_input_bytes: 4096,
  max_output_bytes: 12000,
  filters: {
    ansi: true,
    progress: true,
    repeated_lines: true,
    package_manager: true,
    test_output: true,
    stack_trace: true,
    diff_context: true,
  },
};

export function normalizeSignalFilterProjectPath(value: string): string {
  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;
  const absolute = path.normalize(path.resolve(expanded));
  return absolute.replace(/[\\/]+$/, '') || path.parse(absolute).root;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function resolveSignalFilterConfig(config: NexusConfig, repoPath: string): ResolvedSignalFilterConfig {
  const global = config.signal_filters ?? {
    ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
    projects: {},
  };
  const normalizedRepo = normalizeSignalFilterProjectPath(repoPath);
  const project = Object.entries(global.projects ?? {}).find(
    ([key]) => normalizeSignalFilterProjectPath(key) === normalizedRepo,
  )?.[1];

  return {
    enabled: project?.enabled ?? global.enabled ?? DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG.enabled,
    min_input_bytes: positiveInteger(
      project?.min_input_bytes ?? global.min_input_bytes,
      DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG.min_input_bytes,
    ),
    max_output_bytes: positiveInteger(
      project?.max_output_bytes ?? global.max_output_bytes,
      DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG.max_output_bytes,
    ),
    filters: {
      ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG.filters,
      ...(global.filters ?? {}),
      ...(project?.filters ?? {}),
    },
  };
}
