import type { AgentRunView } from '../chat/agent-run-state';

export function runPhaseLabel(run: AgentRunView): string {
  const active = [...run.tools].reverse().find((tool) => tool.status === 'running');
  if (active?.name === 'Bash') return 'Running command';
  if (active?.name === 'Write') return 'Writing file';
  if (active?.name === 'Edit') return 'Editing file';
  if (active?.name === 'Read') return 'Reading file';
  if (active) return `Running ${active.name}`;
  if (run.phase === 'preparing_tool') return 'Preparing tool input';
  if (run.phase === 'tool_queued') return 'Tool queued';
  if (run.phase === 'model_responding') return 'Model responding';
  return 'Waiting for first provider event';
}

export function terminalLabel(run: AgentRunView): string {
  if (run.status === 'cancelled' && run.abortSource === 'user') return 'Cancelled by user';
  if (run.status === 'cancelled' && run.abortSource === 'frontend') return 'Cancelled by frontend';
  if (run.status === 'cancelled') return 'Cancelled';
  if (run.status === 'interrupted') return 'Interrupted';
  if (run.status === 'failed') return run.abortSource ? `Failed · ${run.abortSource}` : 'Failed';
  return 'Completed';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
