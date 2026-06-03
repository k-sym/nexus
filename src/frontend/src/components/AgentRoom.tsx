import { Task } from '@nexus/shared';
import { AgentStatus, AgentHealth } from '../api';
import ChatPanel from './ChatPanel';

interface AgentRoomProps {
  projectId: string;
  slug: string;
  name: string;
  agent?: AgentStatus;
  runningTasks: Task[];
}

const DOT: Record<AgentHealth, string> = {
  online: 'bg-emerald-500',
  ready: 'bg-amber-500',
  offline: 'bg-zinc-600',
};

export default function AgentRoom({ projectId, slug, name, agent, runningTasks }: AgentRoomProps) {
  const dot = DOT[agent?.status ?? 'offline'];

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dot}`} title={agent?.status ?? 'offline'} />
          <span className="font-semibold text-zinc-100">{name}</span>
          {agent && (
            <span className="text-xs text-zinc-500">
              {agent.provider} · {agent.model || '—'}
              {agent.detail ? ` · ${agent.detail}` : ''}
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500">
          {runningTasks.length} running · {agent?.status ?? 'offline'}
        </span>
      </header>

      {runningTasks.length > 0 && (
        <div className="px-5 py-2 border-b border-zinc-800 shrink-0 flex items-center gap-2 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500/60 shrink-0">Running</span>
          {runningTasks.map(t => (
            <span
              key={t.id}
              className="shrink-0 flex items-center gap-1.5 text-xs text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-full px-2.5 py-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {t.title}
            </span>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <ChatPanel key={`${projectId}:${slug}`} projectId={projectId} agentSlug={slug} />
      </div>
    </div>
  );
}
