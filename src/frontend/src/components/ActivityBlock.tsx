import { Spinner } from '@phosphor-icons/react';
import type { ToolCallInfo } from '@nexus/shared';

interface ActivityBlockProps {
  toolCalls: ToolCallInfo[];
  active?: boolean;
}

function runningLabel(name?: string): string {
  switch (name) {
    case 'Write': return 'Writing file…';
    case 'Edit': return 'Editing file…';
    case 'Read': return 'Reading file…';
    case 'Bash': return 'Running command…';
    case 'Grep': return 'Searching…';
    case 'WebSearch': return 'Searching web…';
    case 'CodeSearch': return 'Searching code…';
    case 'FetchContent': return 'Fetching…';
    case 'Find': return 'Finding files…';
    case 'LS': return 'Listing…';
    case 'TodoWrite': return 'Updating todo list…';
    case 'TodoRead': return 'Reading todo list…';
    case 'AskUserQuestion': return 'Asking user…';
    case 'Task': return 'Dispatching sub-agent…';
    default: return name ? `${name}…` : 'Working…';
  }
}

export function ActivityBlock({ toolCalls, active }: ActivityBlockProps) {
  const running = toolCalls.filter(tc => tc.status === 'running');
  const completed = toolCalls.filter(tc => tc.status === 'completed').length;
  const errors = toolCalls.filter(tc => tc.status === 'error').length;

  if (!active && running.length === 0) {
    if (completed === 0 && errors === 0) return null;
    const parts: string[] = [];
    if (completed > 0) parts.push(`${completed} done`);
    if (errors > 0) parts.push(`${errors} failed`);
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 my-1">
        <span className="text-zinc-600">●</span>
        {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''}
        {parts.length > 0 && (
          <>
            <span className="text-zinc-700">·</span>
            {parts.join(' · ')}
          </>
        )}
      </div>
    );
  }

  const current = running[0];
  const completedSoFar = toolCalls.filter(
    tc => tc.status === 'completed' || tc.id === current?.id,
  ).length - (current ? 0 : 0);

  return (
    <div className="flex items-center gap-1.5 text-xs text-zinc-400 my-1.5 pl-2 border-l-2 border-indigo-500/40">
      <Spinner className="w-3 h-3 animate-spin text-indigo-400" />
      <span className="italic">{runningLabel(current?.name)}</span>
      {completedSoFar > 0 && (
        <span className="text-zinc-600 text-[10px]">
          ({completedSoFar}/{toolCalls.length})
        </span>
      )}
      {running.length > 1 && (
        <span className="text-zinc-600 text-[10px]">+{running.length - 1} more</span>
      )}
    </div>
  );
}

interface ToolCallSummaryProps {
  toolCalls: ToolCallInfo[];
}

export function ToolCallSummary({ toolCalls }: ToolCallSummaryProps) {
  const running = toolCalls.filter(tc => tc.status === 'running').length;
  const completed = toolCalls.filter(tc => tc.status === 'completed').length;
  const errors = toolCalls.filter(tc => tc.status === 'error').length;

  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} done`);
  if (running > 0) parts.push(`${running} running`);
  if (errors > 0) parts.push(`${errors} failed`);

  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
      <span className="text-zinc-600">●</span>
      {toolCalls.length} tool{toolCalls.length !== 1 ? 's' : ''}
      {parts.length > 0 && (
        <>
          <span className="text-zinc-700">·</span>
          {parts.join(' · ')}
        </>
      )}
    </span>
  );
}
