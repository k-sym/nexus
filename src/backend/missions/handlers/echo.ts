import type { MissionHandler } from '../types.js';

/**
 * Deterministic built-in handler. Reads `config.message` and echoes it.
 * If `config.drainAfter` is set, reports `drained: true` once runNumber > drainAfter
 * so backlog_drain pacing can be exercised in tests without any model calls.
 */
export const echoHandler: MissionHandler = async (ctx) => {
  const config = JSON.parse(ctx.mission.config_json || '{}') as { message?: string; drainAfter?: number };
  const drained = typeof config.drainAfter === 'number' && ctx.runNumber > config.drainAfter;
  return {
    status: 'succeeded',
    intent: config.message ?? `echo run ${ctx.runNumber}`,
    selectedWork: { runNumber: ctx.runNumber },
    summary: drained ? 'no work remaining' : `echoed: ${config.message ?? 'hello'}`,
    tokensUsed: 0,
    drained,
  };
};
