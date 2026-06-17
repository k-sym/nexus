import type Database from 'better-sqlite3';
import type { ChatThread, Project } from '@nexus/shared';
import type { PiRuntime } from '../pi/runtime.js';
import { loadConfig, resolveEnvVars } from '../config.js';
import { addMemory, type MemoryInput } from '../memory/index.js';

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

interface ArchiveDeps {
  summarize?: (input: { thread: ChatThread; project: Project; transcript: string }) => Promise<string>;
  storeMemory?: (input: MemoryInput) => Promise<{ id: string } | null>;
}

export async function archiveThreadToMemory(
  db: Database.Database,
  pi: Pick<PiRuntime, 'readMessages' | 'dropSession'>,
  threadId: string,
  deps: ArchiveDeps = {},
): Promise<{ memoryId: string | null }> {
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
  if (!thread) throw new ArchiveThreadError(404, 'Thread not found');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(thread.project_id) as Project | undefined;
  if (!project) throw new ArchiveThreadError(404, 'Project not found');

  const transcript = await loadTranscript(db, pi, thread.id, project.repo_path);
  if (!hasMeaningfulTranscript(transcript)) {
    throw new ArchiveThreadError(400, 'Session has no meaningful chat history to archive');
  }

  const summarize = deps.summarize ?? summarizeWithLocalModel;
  const summary = (await summarize({ thread, project, transcript })).trim();
  if (!summary) throw new ArchiveThreadError(502, 'Local model returned an empty archive summary');

  const storeMemory = deps.storeMemory ?? ((input: MemoryInput) => addMemory(db, input));
  const stored = await storeMemory({
    project_id: project.id,
    agent_id: 'session-archive',
    category: 'session_archive',
    content: summary,
    metadata: {
      source: 'session-archive',
      thread_id: thread.id,
      thread_title: thread.title,
    },
  });
  if (!stored) throw new ArchiveThreadError(502, 'Failed to write archive summary to memory');

  db.prepare('DELETE FROM chat_threads WHERE id = ?').run(thread.id);
  pi.dropSession(thread.id, project.repo_path);
  return { memoryId: stored.id };
}

async function loadTranscript(
  db: Database.Database,
  pi: Pick<PiRuntime, 'readMessages'>,
  threadId: string,
  cwd: string,
): Promise<string> {
  let messages: TranscriptMessage[] = [];
  try {
    messages = entriesToTranscriptMessages(await pi.readMessages(threadId, cwd));
  } catch (err: any) {
    console.error(`[archive] failed to read pi session ${threadId}:`, err?.message);
  }
  if (messages.length === 0) messages = dbTranscriptMessages(db, threadId);
  return messages.map((message) => `${message.role.toUpperCase()}: ${message.text}`).join('\n\n').slice(0, 30000);
}

function entriesToTranscriptMessages(entries: unknown[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const entry of entries as Array<{ message?: { role?: string; content?: unknown } }>) {
    const message = entry.message;
    if (!message?.role) continue;
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
