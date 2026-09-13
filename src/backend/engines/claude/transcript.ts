/**
 * Replays a Claude Code transcript (what `getSessionMessages` returns for a
 * session under `~/.claude/projects/<cwd-slug>/`) into a thread's Pi-shaped
 * JSONL, and keeps the `nexus.desktop_sync` cursor that makes the replay
 * idempotent. Used when a Claude Desktop session is imported and, after a
 * handoff, every time a shared thread is opened or prompted so turns made in
 * the desktop app show up in Nexus.
 *
 * The assistant/tool-result mapping is the live turn's `SdkEventMapper` with
 * no-op sinks — one converter for both paths. Human prompts are persisted here
 * (the mapper deliberately ignores them: on a live turn Nexus wrote the
 * prompt itself).
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getSessionMessages as sdkGetSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { UserMessage } from '@earendil-works/pi-ai';
import { DESKTOP_SYNC_CUSTOM_TYPE, type DesktopSyncRecord } from '@nexus/shared';
import { SdkEventMapper } from './events.js';
import { CLAUDE_CODE_PROVIDER } from './models.js';

export type GetSessionMessagesFn = (sessionId: string, options: { dir: string }) => Promise<SessionMessage[]>;

type TranscriptSessionManager = Pick<SessionManager, 'appendMessage' | 'appendCustomEntry' | 'getEntries'>;

/**
 * `~/.claude/projects/<slug>` for a cwd — the SDK's own naming: the resolved
 * path (no trailing slash; project rows sometimes carry one) with every
 * non-alphanumeric character replaced by a dash.
 */
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(configDir, 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

export function transcriptPath(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeProjectDir(cwd, env), `${sessionId}.jsonl`);
}

/** Size and mtime of the transcript, or null when it does not exist. */
export function transcriptStat(cwd: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(transcriptPath(cwd, sessionId, env));
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** The last `nexus.desktop_sync` entry in the thread's JSONL, if any. */
export function readSyncCursor(sessionManager: Pick<SessionManager, 'getEntries'>): DesktopSyncRecord | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as any;
    if (entry?.type !== 'custom' || entry.customType !== DESKTOP_SYNC_CUSTOM_TYPE) continue;
    const data = entry.data as DesktopSyncRecord | undefined;
    if (data && typeof data.lastUuid === 'string') return data;
  }
  return undefined;
}

export function writeSyncCursor(sessionManager: Pick<SessionManager, 'appendCustomEntry'>, cursor: Omit<DesktopSyncRecord, 'syncedAt'>, now: () => number = Date.now): DesktopSyncRecord {
  const record: DesktopSyncRecord = { ...cursor, syncedAt: new Date(now()).toISOString() };
  sessionManager.appendCustomEntry(DESKTOP_SYNC_CUSTOM_TYPE, record);
  return record;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('');
}

/**
 * What a person (or another session) actually said, out of what Claude Code
 * stores as a user entry: injected `<system-reminder>` blocks are dropped (the
 * desktop app prepends one when it takes over a session), a
 * `<cross-session-message>` wrapper is unwrapped to its body, and entries that
 * are only slash-command echoes or injected context yield nothing.
 */
export function humanPromptText(text: string): string {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  cleaned = cleaned.replace(/<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/gi, (_m, body: string) => body);
  const trimmed = cleaned.trim();
  if (!trimmed) return '';
  if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification)\b/i.test(trimmed)) return '';
  return trimmed;
}

/**
 * Claude Code stores one assistant entry per content block, each carrying the
 * response's `message.id` and (unlike the live stream's frames) the final
 * `stop_reason`. Fold consecutive entries of one response into a single
 * message before the mapper sees them, or every block would flush on its own.
 */
function foldAssistantBlocks(messages: SessionMessage[]): SessionMessage[] {
  const folded: SessionMessage[] = [];
  for (const entry of messages) {
    const previous = folded.at(-1);
    const raw = entry.message as any;
    const prevRaw = previous?.message as any;
    if (
      entry.type === 'assistant' && previous?.type === 'assistant'
      && !entry.parent_tool_use_id && !previous.parent_tool_use_id
      && raw?.id && raw.id === prevRaw?.id && Array.isArray(raw.content) && Array.isArray(prevRaw.content)
    ) {
      folded[folded.length - 1] = {
        ...entry,
        message: { ...prevRaw, ...raw, content: [...prevRaw.content, ...raw.content] },
      };
      continue;
    }
    folded.push(entry);
  }
  return folded;
}

export interface ReplayOptions {
  /** Pi provider/model stamped on assistant messages whose frame carries no model. */
  model: string;
  contextWindow?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ReplayResult {
  /** Messages appended to the Pi JSONL (prompts, assistant turns, tool results). */
  appended: number;
  /** The last SDK message uuid replayed, or undefined when `messages` was empty. */
  lastUuid: string | undefined;
  /** The model of the last assistant message seen, when any. */
  lastModel: string | undefined;
}

/**
 * Append `messages` (already sliced past the cursor) to the thread's Pi JSONL.
 * Subagent traffic is skipped by the mapper; `system` entries carry nothing
 * Nexus renders.
 */
export function replaySdkMessages(sessionManager: TranscriptSessionManager, messages: SessionMessage[], options: ReplayOptions): ReplayResult {
  const now = options.now ?? Date.now;
  let appended = 0;
  let lastModel: string | undefined;
  const mapper = new SdkEventMapper({
    provider: CLAUDE_CODE_PROVIDER,
    model: options.model,
    contextWindow: options.contextWindow ?? 200_000,
    emit: () => {},
    persist: (message) => {
      sessionManager.appendMessage(message as any);
      appended += 1;
      if (message.role === 'assistant' && message.model) lastModel = message.model;
    },
    detailsFor: () => undefined,
    onSessionId: () => {},
    onContextUsage: () => {},
    now,
  });
  for (const entry of foldAssistantBlocks(messages)) {
    const raw = entry.message as any;
    if (entry.type === 'assistant') {
      mapper.handle({ type: 'assistant', parent_tool_use_id: entry.parent_tool_use_id, message: raw, uuid: entry.uuid, session_id: entry.session_id } as any);
      continue;
    }
    if (entry.type !== 'user' || entry.parent_tool_use_id) continue;
    const content = raw?.content;
    const hasToolResult = Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result');
    if (hasToolResult) {
      mapper.handle({ type: 'user', parent_tool_use_id: null, message: raw, uuid: entry.uuid, session_id: entry.session_id } as any);
      continue;
    }
    const text = humanPromptText(textOf(content));
    if (!text) continue;
    // A prompt closes the previous response the way a live `user` frame does.
    mapper.handle({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [] }, uuid: entry.uuid, session_id: entry.session_id } as any);
    const message: UserMessage = { role: 'user', content: text, timestamp: now() };
    sessionManager.appendMessage(message as any);
    appended += 1;
  }
  // Flush a response still buffered (the transcript ends mid-turn, or the last
  // frame carried no stop reason).
  mapper.handle({ type: 'result', subtype: 'success', is_error: false, usage: {}, modelUsage: {} } as any);
  return { appended, lastUuid: messages.at(-1)?.uuid, lastModel };
}

export interface ReconcileDeps {
  sessionManager: TranscriptSessionManager;
  cwd: string;
  sessionId: string;
  model: string;
  contextWindow?: number;
  getSessionMessages?: GetSessionMessagesFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ReconcileResult {
  appended: number;
  skipped: 'unchanged' | 'missing' | null;
  cursor: DesktopSyncRecord | undefined;
}

/**
 * Bring the Pi JSONL up to date with the shared transcript. Cheap when nothing
 * changed (one stat). Idempotent: a message is replayed once, keyed on the
 * cursor's `lastUuid` (falling back to the message count when the uuid is not
 * found, which happens when the SDK reshapes what it lists).
 */
export async function reconcileSharedTranscript(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = deps.now ?? Date.now;
  const stat = transcriptStat(deps.cwd, deps.sessionId, deps.env);
  if (!stat) return { appended: 0, skipped: 'missing', cursor: readSyncCursor(deps.sessionManager) };
  const cursor = readSyncCursor(deps.sessionManager);
  if (cursor && cursor.fileSize === stat.size) return { appended: 0, skipped: 'unchanged', cursor };

  const getMessages = deps.getSessionMessages ?? ((id, options) => sdkGetSessionMessages(id, options));
  const messages = await getMessages(deps.sessionId, { dir: deps.cwd });
  let start = 0;
  if (cursor) {
    if (cursor.lastUuid) {
      const index = messages.findIndex((message) => message.uuid === cursor.lastUuid);
      if (index >= 0) start = index + 1;
      else {
        deps.log?.(`[claude-desktop] cursor ${cursor.lastUuid} not found in ${deps.sessionId}; falling back to offset ${cursor.messageCount}`);
        start = Math.min(cursor.messageCount, messages.length);
      }
    } else {
      start = Math.min(cursor.messageCount, messages.length);
    }
  }
  const fresh = messages.slice(start);
  const result = replaySdkMessages(deps.sessionManager, fresh, { model: deps.model, contextWindow: deps.contextWindow, now, log: deps.log });
  const next = writeSyncCursor(deps.sessionManager, {
    lastUuid: result.lastUuid ?? cursor?.lastUuid ?? messages.at(-1)?.uuid ?? '',
    messageCount: messages.length,
    fileSize: stat.size,
  }, now);
  return { appended: result.appended, skipped: null, cursor: next };
}

/**
 * Move the cursor to the end of the transcript without replaying anything —
 * after a Nexus turn, whose entries the session already persisted itself.
 */
export async function advanceSyncCursorToEnd(deps: Omit<ReconcileDeps, 'model' | 'contextWindow'>): Promise<DesktopSyncRecord | undefined> {
  const stat = transcriptStat(deps.cwd, deps.sessionId, deps.env);
  if (!stat) return undefined;
  const getMessages = deps.getSessionMessages ?? ((id, options) => sdkGetSessionMessages(id, options));
  const messages = await getMessages(deps.sessionId, { dir: deps.cwd });
  return writeSyncCursor(deps.sessionManager, { lastUuid: messages.at(-1)?.uuid ?? '', messageCount: messages.length, fileSize: stat.size }, deps.now ?? Date.now);
}

/**
 * Wait until the transcript stops growing — a desktop turn may be mid-flight
 * when Nexus is asked for one. Bounded; returns as soon as two consecutive
 * stats agree, or after `maxMs`.
 */
export async function waitForTranscriptToSettle(cwd: string, sessionId: string, options: { maxMs?: number; intervalMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const maxMs = options.maxMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + maxMs;
  let previous = transcriptStat(cwd, sessionId, options.env);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const current = transcriptStat(cwd, sessionId, options.env);
    if (!current || !previous) return;
    if (current.size === previous.size && current.mtimeMs === previous.mtimeMs) return;
    previous = current;
  }
}
