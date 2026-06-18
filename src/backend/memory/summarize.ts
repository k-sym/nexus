/**
 * Summarize a completed task-chat into project memory + Obsidian.
 *
 * When a task linked to a chat thread is advanced to Review/Deploy, we read the
 * thread's conversation, extract the agent's assistant output, store key
 * insights via the memory daemon (`addMemory`), and write an Obsidian task
 * summary (`writeTaskSummary`). This replaces what the old headless
 * orchestrator did automatically on dispatch completion — now it's tied to an
 * explicit, user-driven status change instead.
 */
import type Database from 'better-sqlite3';
import type { Project } from '@nexus/shared';
import type { PiRuntime } from '../pi/runtime.js';
import { addMemory } from './index.js';
import { writeTaskSummary } from './obsidian.js';
import { loadConfig } from '../config.js';
import { resolveSignalFilterConfig, type ResolvedSignalFilterConfig } from '../signal-filters/config.js';
import { projectToolResultMessages } from '../signal-filters/messages.js';

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  thread_id: string | null;
  model_key: string | null;
}

interface TaskSummaryDeps {
  resolveFilters?: (repoPath: string) => ResolvedSignalFilterConfig;
}

/**
 * Pull the assistant's text out of pi session message entries. Each entry is
 * `{ type: 'message', message: { role, content: [...] } }`; assistant content
 * is an array of blocks where `text` blocks carry the prose we care about.
 */
export function extractAssistantText(entries: unknown[]): string {
  const parts: string[] = [];
  for (const entry of entries as Array<{ message?: { role?: string; content?: unknown } }>) {
    const message = entry.message;
    if (!message || message.role !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text' && block.text?.trim()) parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/** Fallback: the persisted assistant turns from `chat_messages` (older threads
 *  or threads whose pi session file isn't on disk). */
function dbAssistantText(db: Database.Database, threadId: string): string {
  try {
    const rows = db
      .prepare(
        "SELECT content FROM chat_messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at ASC",
      )
      .all(threadId) as Array<{ content: string }>;
    return rows.map((r) => r.content).filter((c) => c?.trim()).join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Heuristic insight extraction — mirrors the old orchestrator's
 * `extractAndStoreMemory`: pull "decision/important/learned/…" sentences as
 * discrete memories, plus one rollup decision memory for the whole task.
 */
async function extractAndStoreMemory(
  db: Database.Database,
  project: Project,
  task: TaskRow,
  output: string,
): Promise<void> {
  const sentences = output.split(/[.\n]+/).filter((s) => s.trim().length > 20);
  const keyInsights: string[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (
      lower.includes('decided') ||
      lower.includes('decision') ||
      lower.includes('chose') ||
      lower.includes('important') ||
      lower.includes('key') ||
      lower.includes('critical') ||
      lower.includes('note') ||
      lower.includes('remember') ||
      lower.includes('learned') ||
      lower.includes('found that') ||
      lower.includes('discovered') ||
      lower.includes('insight')
    ) {
      keyInsights.push(sentence.trim());
    }
  }
  for (const insight of keyInsights.slice(0, 3)) {
    try {
      await addMemory(db, {
        project_id: project.id,
        agent_id: 'task-chat',
        category: 'agent_run',
        content: insight.slice(0, 500),
        metadata: { task_id: task.id, source: 'task-chat' },
      });
    } catch {
      /* best-effort */
    }
  }
  try {
    await addMemory(db, {
      project_id: project.id,
      agent_id: 'task-chat',
      category: 'decision',
      content: `Completed "${task.title}": ${output.slice(0, 300)}`,
      metadata: { task_id: task.id, source: 'task-chat-summary' },
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Summarize a task's linked chat thread into memory + Obsidian. Best-effort:
 * a missing thread, empty conversation, or unreachable memory daemon is logged
 * and skipped, never thrown.
 *
 * Returns true if a summary was written, false if there was nothing to do.
 */
export async function summarizeTaskThread(
  db: Database.Database,
  pi: PiRuntime,
  task: TaskRow,
  deps: TaskSummaryDeps = {},
): Promise<boolean> {
  if (!task.thread_id) return false;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as
    | Project
    | undefined;
  if (!project) return false;

  let entries: unknown[] = [];
  try {
    entries = await pi.readMessages(task.thread_id, project.repo_path);
  } catch (err: any) {
    console.error(`[summarize] failed to read thread ${task.thread_id}:`, err?.message);
  }

  try {
    const resolveFilters = deps.resolveFilters
      ?? ((repoPath: string) => resolveSignalFilterConfig(loadConfig(), repoPath));
    entries = projectTaskSummaryEntries(entries, project.repo_path, resolveFilters(project.repo_path));
  } catch {
    // Fail open to the original entries. Extraction below still excludes tool results.
  }

  let output = extractAssistantText(entries);
  if (!output.trim()) output = dbAssistantText(db, task.thread_id);
  if (!output.trim()) {
    console.log(`[summarize] task ${task.id} thread has no assistant output yet — skipping`);
    return false;
  }

  await extractAndStoreMemory(db, project, task, output);
  try {
    writeTaskSummary(
      db,
      project,
      task.id,
      task.title,
      task.status,
      output.slice(0, 2000),
      task.model_key || undefined,
    );
  } catch (err: any) {
    console.error(`[summarize] failed to write Obsidian summary for task ${task.id}:`, err?.message);
  }
  console.log(`[summarize] task ${task.id} ("${task.title}") summarized to memory + Obsidian`);
  return true;
}

function projectTaskSummaryEntries(
  entries: unknown[],
  repoPath: string,
  config: ResolvedSignalFilterConfig,
): unknown[] {
  const wrapped = entries as Array<{ message?: unknown }>;
  const sourceMessages = wrapped.map((entry) => entry.message).filter(Boolean);
  const projected = projectToolResultMessages(sourceMessages, repoPath, config).messages;
  let messageIndex = 0;
  return wrapped.map((entry) => {
    if (!entry.message) return entry;
    const message = projected[messageIndex++];
    return message === entry.message ? entry : { ...entry, message };
  });
}
