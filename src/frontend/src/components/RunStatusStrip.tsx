import { useEffect, useState } from 'react';
import { Spinner } from '@phosphor-icons/react';
import type { AgentRunView } from '../chat/agent-run-state';
import { runPhaseLabel, formatElapsed } from './runLabels';

interface RunStatusStripProps {
  run: AgentRunView | null;
  fallbackLabel: string;
}

export function RunStatusStrip({ run, fallbackLabel }: RunStatusStripProps) {
  const [now, setNow] = useState(Date.now());
  const isRunning = run?.status === 'running';
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const label = run ? runPhaseLabel(run) : fallbackLabel;
  const model = run ? [run.provider, run.model].filter(Boolean).join('/') : '';

  return (
    <div
      className="flex items-center gap-2 border-t border-subtle px-4 py-1.5 text-xs text-indigo-200"
      data-testid="run-status"
      aria-live="polite"
    >
      <Spinner className="h-3.5 w-3.5 animate-spin flex-shrink-0" aria-hidden="true" />
      <span className="font-medium">{label}</span>
      {run && (
        <>
          <span className="text-[11px] text-faint">{formatElapsed(now - run.startedAt)}</span>
          <span className="text-[11px] text-faint">· last activity {formatElapsed(now - run.lastEventAt)} ago</span>
          {model && (
            <span className="ml-auto truncate text-[10px] text-faint" title={model}>{model}</span>
          )}
        </>
      )}
    </div>
  );
}
