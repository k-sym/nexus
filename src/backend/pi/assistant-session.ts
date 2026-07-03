/**
 * Assistant Pi-session accessor.
 *
 * Wraps `@earendil-works/pi-coding-agent`'s `SessionManager` statics behind
 * small append/read helpers so the "Assistant" feature's chat transcripts are
 * persisted the same way project chat sessions are — under a fixed synthetic
 * cwd rather than a real repo path. No `AgentSession` / agent loop is
 * involved here; callers drive the run loop themselves and use these helpers
 * to mirror entries into the session file.
 *
 * `SessionManager.list()` is an async static (it lazily parses every session
 * file in the dir to build `SessionInfo[]`), so the lookup helpers here are
 * async too, mirroring the same call shapes as `runtime.ts`'s
 * `createSession` / `readMessages`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ToolCall } from '@earendil-works/pi-ai';
import { AGENT_RUN_CUSTOM_TYPE, type AgentRunStart, type AgentRunEnd } from '@nexus/shared';

export const ASSISTANT_CWD = join(homedir(), '.nexus', 'assistant');

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export async function openAssistantSession(
  sessionId: string,
  sessionDir: string,
  cwd: string = ASSISTANT_CWD,
): Promise<SessionManager> {
  const infos = await SessionManager.list(cwd, sessionDir);
  const match = infos.find((info) => info.id === sessionId);
  return match
    ? SessionManager.open(match.path, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir, { id: sessionId });
}

export function appendUserMessage(sm: SessionManager, text: string): string {
  return sm.appendMessage({ role: 'user', content: text, timestamp: Date.now() } as any);
}

export function appendAssistantMessage(
  sm: SessionManager,
  args: { text: string; thinking?: string; toolCalls?: ToolCall[] },
): string {
  const content: any[] = [];
  if (args.thinking) content.push({ type: 'thinking', thinking: args.thinking });
  if (args.text) content.push({ type: 'text', text: args.text });
  for (const call of args.toolCalls ?? []) content.push(call);
  return sm.appendMessage({
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'hermes',
    model: 'hermes-agent',
    usage: ZERO_USAGE,
    stopReason: (args.toolCalls?.length ?? 0) > 0 ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  } as any);
}

export function appendToolResult(
  sm: SessionManager,
  args: { toolCallId: string; toolName: string; output: string; isError?: boolean },
): string {
  return sm.appendMessage({
    role: 'toolResult',
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    content: [{ type: 'text', text: args.output }],
    isError: Boolean(args.isError),
    timestamp: Date.now(),
  } as any);
}

export function appendRunStart(sm: SessionManager, event: AgentRunStart): string {
  return sm.appendCustomEntry(AGENT_RUN_CUSTOM_TYPE, event);
}

export function appendRunEnd(sm: SessionManager, event: AgentRunEnd): string {
  return sm.appendCustomEntry(AGENT_RUN_CUSTOM_TYPE, event);
}

export async function readAssistantEntries(
  sessionId: string,
  sessionDir: string,
  cwd: string = ASSISTANT_CWD,
): Promise<unknown[]> {
  const infos = await SessionManager.list(cwd, sessionDir);
  const match = infos.find((info) => info.id === sessionId);
  if (!match) return [];
  const sm = SessionManager.open(match.path, sessionDir, cwd);
  return sm.getEntries().filter((entry) =>
    entry.type === 'message' || (entry.type === 'custom' && entry.customType === AGENT_RUN_CUSTOM_TYPE),
  );
}
