import { useEffect, useState } from 'react';
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  Spinner,
  Stop,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
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

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function StatusIcon({ run }: { run: AgentRunView }) {
  if (run.status === 'running') return <Spinner className="h-4 w-4 animate-spin text-indigo-300" aria-hidden="true" />;
  if (run.status === 'completed') return <CheckCircle className="h-4 w-4 text-emerald-400" weight="fill" aria-hidden="true" />;
  if (run.status === 'failed') return <XCircle className="h-4 w-4 text-red-400" weight="fill" aria-hidden="true" />;
  return <WarningCircle className="h-4 w-4 text-amber-300" weight="fill" aria-hidden="true" />;
}

interface AgentRunHeaderProps {
  run: AgentRunView;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
  summary: string;
}

export function AgentRunHeader({ run, expanded, onToggle, onStop, summary }: AgentRunHeaderProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);

  const end = run.completedAt ?? now;
  const label = run.status === 'running' ? runPhaseLabel(run) : terminalLabel(run);
  const model = [run.provider, run.model].filter(Boolean).join('/');

  return (
    <header className="flex items-start gap-2 border-b border-subtle px-3 py-2">
      <span className="mt-0.5"><StatusIcon run={run} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-primary" aria-live="polite">{label}</span>
          <span className="text-[11px] text-faint">{formatElapsed(end - run.startedAt)}</span>
          {model && <span className="truncate text-[10px] text-faint" title={model}>{model}</span>}
        </div>
        <div className="text-[10px] text-faint">
          {run.status === 'running'
            ? `Last activity ${formatElapsed(now - run.lastEventAt)} ago`
            : summary}
        </div>
      </div>
      {run.status === 'running' && (
        <button
          type="button"
          onClick={onStop}
          className="rounded p-1 text-muted hover:bg-white/5 hover:text-primary"
          aria-label="Stop current run"
        >
          <Stop className="h-4 w-4" weight="fill" />
        </button>
      )}
      <button
        type="button"
        onClick={onToggle}
        className="rounded p-1 text-muted hover:bg-white/5 hover:text-primary"
        aria-label={expanded ? 'Collapse run details' : 'Expand run details'}
        aria-expanded={expanded}
      >
        {expanded ? <CaretUp className="h-4 w-4" /> : <CaretDown className="h-4 w-4" />}
      </button>
    </header>
  );
}
