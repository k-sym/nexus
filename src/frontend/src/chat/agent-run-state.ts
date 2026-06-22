import type {
  AgentRunAbortSource,
  AgentRunTerminalStatus,
  AgentRunWireEvent,
} from '@nexus/shared';

export type AgentRunPhase =
  | 'waiting_for_provider'
  | 'model_responding'
  | 'preparing_tool'
  | 'tool_queued'
  | 'tool_running'
  | 'finalizing';

export type AgentToolStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface AgentToolView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: AgentToolStatus;
  queuedAt: number;
  startedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  partialOutput: string;
  result?: string;
  details?: unknown;
  error?: string;
  payloadBytes?: number;
}

export interface AgentRunView {
  runId: string;
  threadId: string;
  status: 'running' | AgentRunTerminalStatus;
  phase: AgentRunPhase;
  startedAt: number;
  lastEventAt: number;
  completedAt?: number;
  provider?: string;
  model?: string;
  abortSource?: AgentRunAbortSource;
  error?: string;
  tools: AgentToolView[];
}

type StartRun = Extract<AgentRunWireEvent, { kind: 'run_start' }>['run'];
type EndRun = Extract<AgentRunWireEvent, { kind: 'run_end' }>['run'];

export type AgentRunAction =
  | { type: 'RUN_STARTED'; run: StartRun }
  | { type: 'MODEL_RESPONDING'; at: number }
  | { type: 'PREPARING_TOOL'; at: number }
  | { type: 'TOOL_QUEUED'; id: string; name: string; args: Record<string, unknown>; at: number }
  | { type: 'TOOL_STARTED'; id: string; name: string; args: Record<string, unknown>; at: number }
  | { type: 'TOOL_OUTPUT'; id: string; output: string; at: number }
  | { type: 'TOOL_FINISHED'; id: string; result: string; details?: unknown; isError: boolean; at: number }
  | { type: 'RUN_ENDED'; run: EndRun }
  | { type: 'RUN_INTERRUPTED'; at: number; error?: string };

function argsBytes(args: Record<string, unknown>): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(args)).byteLength;
  } catch {
    return undefined;
  }
}

function updateTool(
  state: AgentRunView,
  id: string,
  update: (tool: AgentToolView) => AgentToolView,
): AgentToolView[] {
  return state.tools.map((tool) => tool.id === id ? update(tool) : tool);
}

function newTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  at: number,
  status: AgentToolStatus,
): AgentToolView {
  return {
    id,
    name,
    args,
    status,
    queuedAt: at,
    ...(status === 'running' ? { startedAt: at } : {}),
    partialOutput: '',
    payloadBytes: argsBytes(args),
  };
}

export function agentRunReducer(state: AgentRunView | null, action: AgentRunAction): AgentRunView | null {
  if (action.type === 'RUN_STARTED') {
    const startedAt = Date.parse(action.run.startedAt);
    return {
      runId: action.run.runId,
      threadId: action.run.threadId,
      status: 'running',
      phase: 'waiting_for_provider',
      startedAt,
      lastEventAt: startedAt,
      provider: action.run.provider,
      model: action.run.model,
      tools: [],
    };
  }
  if (!state) return state;

  switch (action.type) {
    case 'MODEL_RESPONDING':
      return { ...state, phase: 'model_responding', lastEventAt: action.at };
    case 'PREPARING_TOOL':
      return { ...state, phase: 'preparing_tool', lastEventAt: action.at };
    case 'TOOL_QUEUED': {
      const existing = state.tools.some((tool) => tool.id === action.id);
      const tools = existing
        ? updateTool(state, action.id, (tool) => ({ ...tool, name: action.name, args: action.args }))
        : [...state.tools, newTool(action.id, action.name, action.args, action.at, 'queued')];
      return { ...state, tools, phase: 'tool_queued', lastEventAt: action.at };
    }
    case 'TOOL_STARTED': {
      const existing = state.tools.some((tool) => tool.id === action.id);
      const tools = existing
        ? updateTool(state, action.id, (tool) => ({
            ...tool,
            name: action.name || tool.name,
            args: Object.keys(action.args).length > 0 ? action.args : tool.args,
            status: 'running',
            startedAt: tool.startedAt ?? action.at,
          }))
        : [...state.tools, newTool(action.id, action.name, action.args, action.at, 'running')];
      return { ...state, tools, phase: 'tool_running', lastEventAt: action.at };
    }
    case 'TOOL_OUTPUT':
      return {
        ...state,
        tools: updateTool(state, action.id, (tool) => ({
          ...tool,
          firstOutputAt: tool.firstOutputAt ?? action.at,
          partialOutput: tool.partialOutput + action.output,
        })),
        phase: 'tool_running',
        lastEventAt: action.at,
      };
    case 'TOOL_FINISHED':
      return {
        ...state,
        tools: updateTool(state, action.id, (tool) => ({
          ...tool,
          status: action.isError ? 'failed' : 'succeeded',
          completedAt: action.at,
          result: action.result,
          details: action.details,
          error: action.isError ? action.result : undefined,
        })),
        phase: 'model_responding',
        lastEventAt: action.at,
      };
    case 'RUN_ENDED': {
      const completedAt = Date.parse(action.run.completedAt);
      const unfinishedStatus = action.run.status === 'cancelled' ? 'cancelled' : 'interrupted';
      return {
        ...state,
        status: action.run.status,
        phase: 'finalizing',
        completedAt,
        lastEventAt: completedAt,
        abortSource: action.run.abortSource,
        error: action.run.error,
        tools: state.tools.map((tool) =>
          tool.status === 'queued' || tool.status === 'running'
            ? { ...tool, status: unfinishedStatus, completedAt }
            : tool,
        ),
      };
    }
    case 'RUN_INTERRUPTED':
      return {
        ...state,
        status: 'interrupted',
        phase: 'finalizing',
        completedAt: action.at,
        lastEventAt: action.at,
        error: action.error,
        tools: state.tools.map((tool) =>
          tool.status === 'queued' || tool.status === 'running'
            ? { ...tool, status: 'interrupted', completedAt: action.at }
            : tool,
        ),
      };
  }
}
