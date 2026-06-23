export const AGENT_RUN_CUSTOM_TYPE = 'nexus.agent_run' as const;

export type AgentRunAbortSource =
  | 'user'
  | 'frontend'
  | 'backend'
  | 'timeout'
  | 'provider'
  | 'runtime';

export type AgentRunTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface AgentRunStart {
  event: 'start';
  runId: string;
  threadId: string;
  startedAt: string;
  provider?: string;
  model?: string;
}

export interface AgentRunEnd {
  event: 'end';
  runId: string;
  threadId: string;
  assistantEntryId?: string;
  completedAt: string;
  status: AgentRunTerminalStatus;
  abortSource?: AgentRunAbortSource;
  error?: string;
}

export type AgentRunSessionEvent = AgentRunStart | AgentRunEnd;

export type AgentRunWireEvent =
  | { kind: 'run_start'; run: Omit<AgentRunStart, 'event'> }
  | { kind: 'run_end'; run: Omit<AgentRunEnd, 'event'> };
