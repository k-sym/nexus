/**
 * Orchestrator — the dispatch engine.
 *
 * Polls every 5s for tasks in "in_progress" that have no running agent, then
 * resolves a persona, builds a context-rich prompt, dispatches to the correct
 * provider (Claude Code / Codex subprocess, or OpenRouter / local
 * OpenAI-compatible HTTP), and advances or fails the task. Also runs the 48h chat
 * archival sweep and extracts key insights into the memory store.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { TaskStatus } from '@nexus/shared';
import { getNexusDir, loadConfig, resolveOpenRouterKey, resolveEnvVars } from '../config';
import { buildTaskContext, buildAgentPrompt, TaskContext } from './context';
import { runClaudeCode, runCodex, runOpenAICompatible, ProviderResult } from './providers';
import { addMemory, projectSlug } from '../memory';
import { writeTaskSummary, writeChatArchive } from '../memory/obsidian';

const POLL_INTERVAL_MS = 5000;

export function startOrchestrator(db: Database.Database) {
  console.log('[orchestrator] Starting...');

  setInterval(() => {
    try {
      pollAndDispatch(db);
      archiveOldChats(db);
    } catch (err) {
      console.error('[orchestrator] Poll error:', err);
    }
  }, POLL_INTERVAL_MS);
}

function pollAndDispatch(db: Database.Database) {
  const config = loadConfig();

  const rows = db.prepare(
    `SELECT * FROM tasks WHERE status = 'in_progress'
     AND id NOT IN (SELECT task_id FROM agent_runs WHERE status = 'running')`
  ).all() as any[];

  if (rows.length === 0) return;

  for (const row of rows) {
    dispatchTask(db, config, row).catch(err => {
      console.error(`[orchestrator] Failed to dispatch task ${row.id}:`, err);
    });
  }
}

async function dispatchTask(db: Database.Database, config: ReturnType<typeof loadConfig>, taskRow: any) {
  const taskId = taskRow.id;
  console.log(`[orchestrator] Dispatching task: ${taskRow.title} (${taskId})`);

  const runId = recordAgentRun(db, taskId, 'running');
  let ctx: TaskContext;

  try {
    ctx = await buildTaskContext(db, taskRow as any);
  } catch (err: any) {
    completeAgentRun(db, runId, 'failed', '', err.message);
    moveTask(db, projectId(db, taskId, taskRow.project_id), taskId, 'triage');
    return;
  }

  const prompt = buildAgentPrompt(ctx);
  const outputPath = getOutputPath(ctx.project.slug, taskId);
  const persona = ctx.persona;
  const workspace = resolveWorkspace(persona.workspace, ctx.project.repo_path, ctx.project.slug);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const appendOutput = (chunk: string) => {
    try { fs.appendFileSync(outputPath, chunk); } catch { /* ignore */ }
  };

  let result: ProviderResult;

  switch (persona.provider) {
    case 'claude_code':
      console.log(`[orchestrator] Spawning Claude Code for task ${taskId}`);
      result = await runClaudeCode(workspace, prompt, appendOutput, config.claude_code, persona.model);
      break;

    case 'codex':
      console.log(`[orchestrator] Spawning Codex for task ${taskId}`);
      result = await runCodex(workspace, prompt, appendOutput, config.codex, persona.model);
      break;

    case 'openrouter':
      console.log(`[orchestrator] Calling OpenRouter API for task ${taskId}`);
      result = await runOpenAICompatible(persona, prompt, {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: resolveOpenRouterKey(config),
        headers: { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS Agent' },
      }, appendOutput);
      break;

    case 'local':
    case 'ollama': // legacy alias
      console.log(`[orchestrator] Calling local model server for task ${taskId}`);
      result = await runOpenAICompatible(persona, prompt, {
        baseUrl: config.models.local.base_url,
        apiKey: resolveEnvVars(config.models.local.api_key),
      }, appendOutput);
      break;

    default:
      result = { ok: false, output: '', error: `Unknown provider: ${persona.provider}`, durationMs: 0, usage: { prompt: 0, completion: 0, total: 0 } };
  }

  const status = result.ok ? 'completed' : 'failed';
  completeAgentRun(db, runId, status, result.output, result.error, {
    provider: persona.provider,
    model: persona.model,
    usage: result.usage,
    durationMs: result.durationMs,
  });

  if (result.ok) {
    const nextStatus = getNextStatus(taskRow.status as TaskStatus);
    moveTask(db, ctx.project.id, taskId, nextStatus);
    console.log(`[orchestrator] Task ${taskId} completed -> ${nextStatus}`);

    await extractAndStoreMemory(db, ctx, result.output);
    writeTaskSummary(db, ctx.project, taskId, taskRow.title, nextStatus, result.output.slice(0, 2000), ctx.persona.name);
  } else {
    moveTask(db, ctx.project.id, taskId, 'triage');
    console.log(`[orchestrator] Task ${taskId} failed -> triage (${result.error})`);
  }
}

function getNextStatus(current: TaskStatus): TaskStatus {
  const pipeline: TaskStatus[] = ['triage', 'todo', 'in_progress', 'review', 'deploy'];
  const idx = pipeline.indexOf(current);
  return idx >= 0 && idx < pipeline.length - 1 ? pipeline[idx + 1] : 'deploy';
}

function moveTask(db: Database.Database, projectId: string, taskId: string, status: TaskStatus) {
  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, taskId);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
}

function projectId(db: Database.Database, taskId: string, fallback: string): string {
  const row = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
  return row?.project_id || fallback;
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(process.env.HOME || '', p.slice(1));
  return p;
}

/**
 * Resolve the working directory an agent runs in. The default personas use a
 * `~/Projects/{project}` template, which is just a placeholder — the real
 * location is the project's registered repo_path, so we prefer that. Only a
 * persona workspace with no `{project}` placeholder is treated as a genuine
 * custom path and honored as-is.
 */
function resolveWorkspace(template: string, repoPath: string, slug: string): string {
  const repo = expandHome(repoPath);
  if (!template || template.includes('{project')) return repo;
  return expandHome(template.replace('{project_name}', slug).replace('{project}', slug));
}

function getOutputPath(projectSlug: string, taskId: string): string {
  return path.join(getNexusDir(), 'workspaces', projectSlug, 'outputs', `${taskId}.log`);
}

function recordAgentRun(db: Database.Database, taskId: string, status: string): string {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO agent_runs (id, task_id, status, started_at) VALUES (?, ?, ?, ?)')
    .run(runId, taskId, status, now);
  return runId;
}

function completeAgentRun(
  db: Database.Database,
  runId: string,
  status: string,
  output: string,
  error: string | undefined,
  meta?: { provider: string; model: string; usage: { prompt: number; completion: number; total: number }; durationMs: number },
) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_runs SET
       status = ?, output = ?, error = ?, completed_at = ?,
       provider = ?, model = ?,
       prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, duration_ms = ?
     WHERE id = ?`
  ).run(
    status,
    output.slice(0, 50000),
    error || null,
    now,
    meta?.provider || null,
    meta?.model || null,
    meta?.usage.prompt || 0,
    meta?.usage.completion || 0,
    meta?.usage.total || 0,
    meta?.durationMs || 0,
    runId,
  );
}

async function extractAndStoreMemory(db: Database.Database, ctx: TaskContext, output: string): Promise<void> {
  const sentences = output.split(/[.\n]+/).filter(s => s.trim().length > 20);
  const keyInsights: string[] = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (lower.includes('decided') || lower.includes('decision') || lower.includes('chose') ||
        lower.includes('important') || lower.includes('key') || lower.includes('critical') ||
        lower.includes('note') || lower.includes('remember') || lower.includes('learned') ||
        lower.includes('found that') || lower.includes('discovered') || lower.includes('insight')) {
      keyInsights.push(sentence.trim());
    }
  }

  for (const insight of keyInsights.slice(0, 3)) {
    try {
      await addMemory(db, {
        project_id: ctx.project.id,
        agent_id: ctx.persona.slug,
        category: 'agent_run',
        content: insight.slice(0, 500),
        metadata: { task_id: ctx.task.id, source: 'orchestrator' },
      });
    } catch { /* ignore */ }
  }

  try {
    await addMemory(db, {
      project_id: ctx.project.id,
      agent_id: ctx.persona.slug,
      category: 'decision',
      content: `Completed "${ctx.task.title}": ${output.slice(0, 300)}`,
      metadata: { task_id: ctx.task.id, source: 'orchestrator_summary' },
    });
  } catch { /* ignore */ }
}

function archiveOldChats(db: Database.Database): void {
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const oldThreads = db.prepare(
    `SELECT * FROM chat_threads
     WHERE archived_at IS NULL
     AND updated_at < ?
     AND project_id IS NOT NULL`,
  ).all(fortyEightHoursAgo) as any[];

  for (const thread of oldThreads) {
    try {
      const messages = db.prepare(
        'SELECT role, content, created_at FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC'
      ).all(thread.id) as { role: string; content: string; created_at: string }[];

      if (messages.length < 2) continue;

      const slug = projectSlug(db, thread.project_id);
      if (!slug) continue;
      writeChatArchive(slug, thread.title, thread.id, messages);

      const now = new Date().toISOString();
      db.prepare('UPDATE chat_threads SET archived_at = ? WHERE id = ?').run(now, thread.id);
      db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(thread.id);

      console.log(`[memory] Archived chat thread: ${thread.title} (${thread.id})`);
    } catch (err) {
      console.error(`[memory] Failed to archive thread ${thread.id}:`, err);
    }
  }
}
