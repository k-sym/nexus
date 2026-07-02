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
import { runPhaseLabel, terminalLabel, formatElapsed } from './runLabels';
export { runPhaseLabel, terminalLabel } from './runLabels';

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
