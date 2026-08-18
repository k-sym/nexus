import type Database from 'better-sqlite3';
import type { ChatThread, Project } from '@nexus/shared';
import type { PiRuntime } from '../pi/runtime.js';
import { loadConfig, resolveEnvVars } from '../config.js';
import { addMemory, type MemoryInput } from '../memory/index.js';
import { daemon, DaemonRequestError } from '../memory/client.js';
import { resolveSignalFilterConfig, type ResolvedSignalFilterConfig } from '../signal-filters/config.js';
import { projectToolResultMessages } from '../signal-filters/messages.js';

export class ArchiveThreadError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ArchiveThreadError';
  }
}

interface TranscriptMessage {
  role: string;
  text: string;
}

/** Archiving controls, mirrors NexusConfig.memory.archive. Defaulted from config;
 *  overridable in tests via ArchiveDeps.settings. */
export interface ArchiveSettings {
  max_single_pass_chars: number;
  max_chunks: number;
  summary_target_tokens: number;
  undo_retention_days: number;
}

type SummarizeMode = 'single' | 'chunk' | 'synthesis';

interface SummarizeWindowInput {
  mode: SummarizeMode;
  thread: ChatThread;
  project: Project;
  text: string;
  maxTokens?: number;
}

interface ArchiveDeps {
  /** Single-pass summariser for a whole in-budget transcript (backward compatible). */
  summarize?: (input: { thread: ChatThread; project: Project; transcript: string }) => Promise<string>;
  /** Mode-aware summariser driving the multi-pass roll-up (chunk notes + synthesis). */
  summarizeWindow?: (input: SummarizeWindowInput) => Promise<string>;
  storeMemory?: (input: MemoryInput) => Promise<{ id: string } | null>;
  resolveFilters?: (repoPath: string) => ResolvedSignalFilterConfig;
  /** Override the config-derived archive settings (tests). */
  settings?: ArchiveSettings;
}

export async function archiveThreadToMemory(
  db: Database.Database,
  pi: Pick<PiRuntime, 'readMessages' | 'dropSession'>,
  threadId: string,
  deps: ArchiveDeps = {},
): Promise<{ memoryId: string | null; elided: boolean }> {
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
  if (!thread) throw new ArchiveThreadError(404, 'Thread not found');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(thread.project_id) as Project | undefined;
  if (!project) throw new ArchiveThreadError(404, 'Project not found');

  const settings = deps.settings ?? loadConfig().memory.archive;
  const resolveFilters = deps.resolveFilters
    ?? ((repoPath: string) => resolveSignalFilterConfig(loadConfig(), repoPath));
  const transcript = await loadTranscript(db, pi, thread.id, project.repo_path, resolveFilters);
  if (!hasMeaningfulTranscript(transcript)) {
    throw new ArchiveThreadError(400, 'Session has no meaningful chat history to archive');
  }

  const { summary, elided } = await summarizeTranscript({ thread, project, transcript }, settings, deps);
  if (!summary) throw new ArchiveThreadError(502, 'Archive summary model returned an empty summary');

  // Never drop content without a trace: when the transcript was too large to roll up
  // in full, the summary carries an explicit in-body note (the recall-visible trace).
  const content = elided
    ? `> _Note: this session was long; some middle sections were elided from this summary (start and end preserved)._\n\n${summary}`
    : summary;

  const storeMemory = deps.storeMemory ?? ((input: MemoryInput) => addMemory(db, input));
  const stored = await storeMemory({
    project_id: project.id,
    agent_id: 'session-archive',
    category: 'session_archive',
    content,
    // `source` is not repeated here: agent_id already yields the canonical
    // frontmatter source (`nexus:session-archive`), and the daemon reserves it.
    metadata: {
      thread_id: thread.id,
      thread_title: thread.title,
      elided,
    },
  });
  if (!stored) throw new ArchiveThreadError(502, 'Failed to write archive summary to memory');

  db.prepare('DELETE FROM chat_threads WHERE id = ?').run(thread.id);
  // Tombstone the raw session for the configured undo window instead of an immediate
  // unlink (0 ⇒ hard-delete, preserving the old behaviour).
  pi.dropSession(thread.id, project.repo_path, { tombstoneRetentionDays: settings.undo_retention_days });
  return { memoryId: stored.id, elided };
}

/**
 * Turn a transcript into the stored summary. In-budget transcripts summarise in one
 * pass. Oversized ones are rolled up: split into ordered windows, extract durable
 * notes per window, then synthesise the final structured summary from the ordered
 * notes — so the session's *ending* is never silently dropped. Past `max_chunks`
 * windows we keep head + tail and mark the result elided.
 */
async function summarizeTranscript(
  input: { thread: ChatThread; project: Project; transcript: string },
  settings: ArchiveSettings,
  deps: ArchiveDeps,
): Promise<{ summary: string; elided: boolean }> {
  const { thread, project, transcript } = input;

  if (transcript.length <= settings.max_single_pass_chars) {
    const summarize = deps.summarize ?? summarizeWithMemoryDaemon;
    return { summary: (await summarize({ thread, project, transcript })).trim(), elided: false };
  }

  const summarizeWindow = deps.summarizeWindow ?? summarizeWindowWithDaemon;
  const windows = buildTranscriptWindows(transcript, settings.max_single_pass_chars);
  const { selected, elided } = selectWindows(windows, settings.max_chunks);

  const notes: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const note = (await summarizeWindow({ mode: 'chunk', thread, project, text: selected[i] })).trim();
    if (note && note.toUpperCase() !== 'NONE') notes.push(`Window ${i + 1} of ${selected.length}:\n${note}`);
  }

  // Nothing durable surfaced across the windows — fall back to summarising the final
  // window directly rather than storing an empty memory for a large session.
  if (notes.length === 0) {
    const tail = selected[selected.length - 1];
    const summary = (await summarizeWindow({
      mode: 'single', thread, project, text: tail, maxTokens: settings.summary_target_tokens,
    })).trim();
    return { summary, elided };
  }

  const summary = (await summarizeWindow({
    mode: 'synthesis', thread, project, text: notes.join('\n\n'), maxTokens: settings.summary_target_tokens,
  })).trim();
  return { summary, elided };
}

/**
 * Split a transcript into ordered windows each at most `maxChars`, preferring to break
 * on blank-line (message) boundaries so a window rarely cuts mid-message. A single
 * paragraph larger than a whole window is hard-split as a last resort.
 */
export function buildTranscriptWindows(transcript: string, maxChars: number): string[] {
  const max = Math.max(1, Math.floor(maxChars));
  if (transcript.length <= max) return [transcript];
  const windows: string[] = [];
  let cur = '';
  const flush = () => { if (cur) { windows.push(cur); cur = ''; } };
  for (const para of transcript.split('\n\n')) {
    if (para.length > max) {
      flush();
      for (let i = 0; i < para.length; i += max) windows.push(para.slice(i, i + max));
      continue;
    }
    const piece = cur ? `${cur}\n\n${para}` : para;
    if (piece.length <= max) cur = piece;
    else { flush(); cur = para; }
  }
  flush();
  return windows;
}

/**
 * Keep every window when within `maxChunks`; otherwise keep the first `ceil(n/2)` and
 * last `floor(n/2)` windows (head + tail) and flag elision. The tail is always kept, so
 * the session's ending survives.
 */
export function selectWindows(windows: string[], maxChunks: number): { selected: string[]; elided: boolean } {
  const cap = Math.max(2, Math.floor(maxChunks));
  if (windows.length <= cap) return { selected: windows, elided: false };
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return { selected: [...windows.slice(0, head), ...windows.slice(windows.length - tail)], elided: true };
}

async function loadTranscript(
  db: Database.Database,
  pi: Pick<PiRuntime, 'readMessages'>,
  threadId: string,
  cwd: string,
  resolveFilters: (repoPath: string) => ResolvedSignalFilterConfig,
): Promise<string> {
  let messages: TranscriptMessage[] = [];
  try {
    const entries = await pi.readMessages(threadId, cwd);
    try {
      messages = entriesToTranscriptMessages(entries, cwd, resolveFilters(cwd));
    } catch {
      messages = entriesToTranscriptMessages(entries);
    }
  } catch (err: any) {
    console.error(`[archive] failed to read pi session ${threadId}:`, err?.message);
  }
  if (messages.length === 0) messages = dbTranscriptMessages(db, threadId);
  // Return the whole filtered transcript. Bounding the work for oversized sessions is
  // the roll-up's job (buildTranscriptWindows + max_chunks), so nothing is truncated
  // here — the previous fixed 30k slice silently dropped long sessions' endings.
  return messages
    .map((message) => `${message.role.startsWith('TOOL ') ? message.role : message.role.toUpperCase()}: ${message.text}`)
    .join('\n\n');
}

function entriesToTranscriptMessages(
  entries: unknown[],
  cwd = '',
  config?: ResolvedSignalFilterConfig,
): TranscriptMessage[] {
  const sourceMessages = (entries as Array<{ message?: unknown }>).map((entry) => entry.message).filter(Boolean);
  const projection = config
    ? projectToolResultMessages(sourceMessages, cwd, config)
    : { messages: sourceMessages, resultsByToolCallId: new Map() };
  const messages: TranscriptMessage[] = [];
  for (const message of projection.messages as Array<{
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
  }>) {
    if (!message?.role) continue;
    if (message.role === 'toolResult') {
      const projected = projection.resultsByToolCallId.get(String(message.toolCallId));
      const text = projected?.filteredText ?? contentToText(message.content).trim();
      if (!text) continue;
      const command = projected?.context.command;
      const label = `TOOL ${message.toolName ?? 'unknown'}${command ? ` (${command})` : ''}`;
      messages.push({ role: label, text });
      continue;
    }
    const text = contentToText(message.content).trim();
    if (text) messages.push({ role: message.role, text });
  }
  return messages;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function dbTranscriptMessages(db: Database.Database, threadId: string): TranscriptMessage[] {
  try {
    return db
      .prepare("SELECT role, content FROM chat_messages WHERE thread_id = ? AND content <> '' ORDER BY created_at ASC")
      .all(threadId)
      .map((row: any) => ({ role: row.role, text: row.content }));
  } catch {
    return [];
  }
}

function hasMeaningfulTranscript(transcript: string): boolean {
  return transcript.replace(/\s+/g, ' ').trim().length >= 20;
}

export async function summarizeWithLocalModel(input: {
  thread: ChatThread;
  project: Project;
  transcript: string;
}): Promise<string> {
  const config = loadConfig();
  const baseUrl = config.models.local.base_url.replace(/\/+$/, '');
  const apiKey = resolveEnvVars(config.models.local.api_key || '');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'Summarize this Nexus session for long-term project memory. Keep only durable decisions, constraints, implementation notes, discoveries, user preferences, and follow-up context. Exclude chat filler and transient status.',
        },
        {
          role: 'user',
          content: `Project: ${input.project.name}\nSession: ${input.thread.title}\n\nTranscript:\n${input.transcript}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new ArchiveThreadError(502, `Local model archive summary failed (${res.status}${body ? `: ${body}` : ''})`);
  }
  const json = await res.json();
  return String(json?.choices?.[0]?.message?.content ?? '').trim();
}

/** Default single-pass summariser: one structured summary over the whole transcript. */
export async function summarizeWithMemoryDaemon(input: {
  thread: ChatThread;
  project: Project;
  transcript: string;
}): Promise<string> {
  return summarizeWindowWithDaemon({
    mode: 'single',
    thread: input.thread,
    project: input.project,
    text: input.transcript,
    maxTokens: loadConfig().memory.archive.summary_target_tokens,
  });
}

/** Mode-aware daemon call used by both the single-pass and multi-pass paths. */
async function summarizeWindowWithDaemon(input: SummarizeWindowInput): Promise<string> {
  try {
    const res = await daemon.summarizeSessionArchive({
      projectName: input.project.name,
      threadTitle: input.thread.title,
      transcript: input.text,
      mode: input.mode,
      maxTokens: input.maxTokens,
    });
    return String(res.summary ?? '').trim();
  } catch (err) {
    const detail = err instanceof DaemonRequestError ? err.detail : undefined;
    throw new ArchiveThreadError(
      502,
      detail ? `Memory daemon archive summary failed: ${detail}` : 'Memory daemon archive summary failed',
    );
  }
}
