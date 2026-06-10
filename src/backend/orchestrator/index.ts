/**
 * Orchestrator — the dispatch engine.
 *
 * Polls every 5s for tasks in "in_progress" that have a `model_key` set
 * (i.e. the user has picked a model via the frontend picker) and no running
 * agent. For each, opens a headless pi session bound to the project's
 * repo_path, runs the prompt, captures the assistant text + tool calls,
 * and advances or fails the task. Same `agent_runs` table as before so
 * the Usage page keeps working.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { TaskStatus } from '@nexus/shared';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { getNexusDir } from '../config';
import { addMemory } from '../memory';
import { writeTaskSummary } from '../memory/obsidian';
import type { PiRuntime } from '../pi/runtime';

const POLL_INTERVAL_MS = 5000;

export function startOrchestrator(db: Database.Database, pi: PiRuntime) {
  console.log('[orchestrator] Starting...');

  setInterval(() => {
    try {
      pollAndDispatch(db, pi);
    } catch (err) {
      console.error('[orchestrator] Poll error:', err);
    }
  }, POLL_INTERVAL_MS);
}

function pollAndDispatch(db: Database.Database, pi: PiRuntime) {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'in_progress'
       AND model_key IS NOT NULL AND model_key != ''
       AND id NOT IN (SELECT task_id FROM agent_runs WHERE status = 'running')`,
    )
    .all() as any[];

  for (const row of rows) {
    dispatchTask(db, pi, row).catch((err) => {
      console.error(`[orchestrator] Failed to dispatch task ${row.id}:`, err);
    });
  }
}

async function dispatchTask(db: Database.Database, pi: PiRuntime, taskRow: any) {
  const taskId = taskRow.id;
  const modelKey = String(taskRow.model_key);
  const sep = modelKey.indexOf('/');
  if (sep < 1) {
    console.error(`[orchestrator] Task ${taskId} has malformed model_key: ${modelKey}`);
    return;
  }
  const provider = modelKey.slice(0, sep);
  const modelId = modelKey.slice(sep + 1);
  const model = pi.findModel(provider, modelId);
  if (!model) {
    console.error(`[orchestrator] Task ${taskId}: model ${modelKey} not available (auth not configured?)`);
    moveTask(db, taskRow.project_id, taskId, 'triage');
    return;
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(taskRow.project_id) as
    | { id: string; name: string; slug: string; repo_path: string; description: string }
    | undefined;
  if (!project) return;
  const cwd = project.repo_path;

  const runId = recordAgentRun(db, taskId, 'running', modelKey);
  console.log(`[orchestrator] Dispatching task: ${taskRow.title} (${taskId}) via ${modelKey}`);

  const session = await createHeadlessSession(pi, `task-${taskId}`, cwd, model);
  const prompt = buildTaskPrompt(project, taskRow);
  const startedAt = Date.now();
  let finalOutput = '';

  try {
    const subscription = session.subscribe((ev: unknown) => {
      const e = ev as { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> }; messages?: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }> };
      if (e.type === 'message_end' && e.message?.role === 'assistant') {
        for (const block of e.message.content ?? []) {
          if (block.type === 'text' && block.text) finalOutput += block.text;
        }
      } else if (e.type === 'agent_end') {
        for (const m of e.messages ?? []) {
          if (m.role === 'assistant') {
            for (const block of m.content ?? []) {
              if (block.type === 'text' && block.text && !finalOutput.includes(block.text)) {
                finalOutput += block.text;
              }
            }
          }
        }
      }
    });
    await session.prompt(prompt);
    subscription();

    const durationMs = Date.now() - startedAt;
    const outputPath = getOutputPath(project.slug, taskId);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, finalOutput);

    completeAgentRun(db, runId, 'completed', finalOutput, undefined, {
      provider,
      model: modelId,
      durationMs,
    });
    const nextStatus = getNextStatus(taskRow.status as TaskStatus);
    moveTask(db, project.id, taskId, nextStatus);
    console.log(`[orchestrator] Task ${taskId} completed -> ${nextStatus}`);

    await extractAndStoreMemory(db, project, taskRow, finalOutput);
    writeTaskSummary(db, project as any, taskId, taskRow.title, nextStatus, finalOutput.slice(0, 2000), modelKey);
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    completeAgentRun(db, runId, 'failed', finalOutput, err?.message, {
      provider,
      model: modelId,
      durationMs,
    });
    moveTask(db, project.id, taskId, 'triage');
    console.log(`[orchestrator] Task ${taskId} failed -> triage (${err?.message})`);
  }
}

/**
 * Create a fresh headless session for an orchestrator dispatch.
 *
 * The session is not registered with the runtime's session cache (it's
 * ephemeral — the next task gets its own). No UI bridge is bound; extension
 * dialogs fall back to defaults. The session file lives in the standard
 * per-cwd sessions dir but with a `task-{id}` session id so it doesn't
 * collide with chat sessions.
 */
async function createHeadlessSession(
  pi: PiRuntime,
  sessionId: string,
  cwd: string,
  model: NonNullable<ReturnType<PiRuntime['findModel']>>,
): Promise<AgentSession> {
  const sessionDir = pi.sessionDirFor(cwd);
  const sessionManager = SessionManager.create(cwd, sessionDir, { id: sessionId });
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: pi.paths.sessionsDir,
    settingsManager,
    noExtensions: true,
  });
  await resourceLoader.reload();
  // The Model type is structurally compatible but TS sees them as
  // different nominal types. Cast through unknown to align.
  const m = model as unknown as Parameters<typeof createAgentSession>[0] extends infer P
    ? P extends { model?: infer M }
      ? M
      : never
    : never;
  const { session } = await createAgentSession({
    cwd,
    authStorage: pi.auth as unknown as AuthStorage,
    modelRegistry: pi.models as unknown as ModelRegistry,
    sessionManager,
    settingsManager,
    resourceLoader,
    model: m,
  });
  return session;
}

function buildTaskPrompt(
  project: { name: string; description: string; repo_path: string },
  task: { title: string; description: string; priority: string },
): string {
  const parts: string[] = [];
  parts.push(`You are a coding agent running in a Nexxus headless dispatch.`);
  parts.push(`Project: ${project.name}`);
  if (project.description) parts.push(project.description);
  parts.push(`Working directory: ${project.repo_path}`);
  parts.push(`Priority: ${task.priority}`);
  parts.push('');
  parts.push(`## Task: ${task.title}`);
  if (task.description) parts.push(task.description);
  parts.push('');
  parts.push('Complete this task in the project working directory. Use the Read/Write/Edit/Bash tools. Be concise in your final summary.');
  return parts.join('\n');
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

function getOutputPath(projectSlug: string, taskId: string): string {
  return join(getNexusDir(), 'workspaces', projectSlug, 'outputs', `${taskId}.log`);
}

function recordAgentRun(
  db: Database.Database,
  taskId: string,
  status: string,
  modelKey: string,
): string {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO agent_runs (id, task_id, source, status, model, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(runId, taskId, 'task', status, modelKey, now);
  return runId;
}

function completeAgentRun(
  db: Database.Database,
  runId: string,
  status: string,
  output: string,
  error: string | undefined,
  meta: { provider: string; model: string; durationMs: number },
) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_runs SET
       status = ?, output = ?, error = ?, completed_at = ?,
       provider = ?, model = ?,
       duration_ms = ?
     WHERE id = ?`,
  ).run(
    status,
    output.slice(0, 50000),
    error || null,
    now,
    meta.provider || null,
    meta.model || null,
    meta.durationMs || 0,
    runId,
  );
}

async function extractAndStoreMemory(
  db: Database.Database,
  project: { id: string },
  task: { id: string; title: string },
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
        agent_id: 'orchestrator',
        category: 'agent_run',
        content: insight.slice(0, 500),
        metadata: { task_id: task.id, source: 'orchestrator' },
      });
    } catch {
      /* ignore */
    }
  }
  try {
    await addMemory(db, {
      project_id: project.id,
      agent_id: 'orchestrator',
      category: 'decision',
      content: `Completed "${task.title}": ${output.slice(0, 300)}`,
      metadata: { task_id: task.id, source: 'orchestrator_summary' },
    });
  } catch {
    /* ignore */
  }
}
