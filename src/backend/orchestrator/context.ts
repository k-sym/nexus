/**
 * Task context & prompt assembly.
 *
 * buildTaskContext() resolves the persona (explicit → column default →
 * generalist), gathers the project_docs index, sibling tasks, and relevant
 * memories. buildAgentPrompt() flattens all of that into the single prompt
 * string handed to the provider.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Task, Project, PersonaConfig } from '@nexus/shared';
import yaml from 'js-yaml';
import { getNexusDir } from '../config';
import { getRelevantMemories } from '../memory';

export interface TaskContext {
  project: Project;
  task: Task;
  persona: PersonaConfig;
  projectDocs: string[];
  otherTasks: Task[];
  memoryContext: string;
}

export function buildTaskContext(db: Database.Database, task: Task): TaskContext {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as Project;
  const persona = resolvePersona(db, project, task);
  const projectDocs = listProjectDocs(project.repo_path);
  const otherTasks = db.prepare(
    'SELECT id, title, status, priority FROM tasks WHERE project_id = ? AND id != ?'
  ).all(project.id, task.id) as Task[];
  const query = `${task.title} ${task.description}`.trim();
  const relevantMemories = query.length > 5 ? getRelevantMemories(db, project.id, query) : [];
  const memoryContext = relevantMemories.length > 0
    ? '## Relevant Memories\n' + relevantMemories.map(m => `- ${m}`).join('\n')
    : '';

  return { project, task, persona, projectDocs, otherTasks, memoryContext };
}

function resolvePersona(db: Database.Database, project: Project, task: Task): PersonaConfig {
  const slug = task.assigned_agent || resolveColumnDefault(project, task.status) || 'generalist';

  const personaRow = db.prepare('SELECT config_yaml FROM personas WHERE slug = ?').get(slug) as { config_yaml: string } | undefined;
  if (personaRow) {
    return yaml.load(personaRow.config_yaml) as PersonaConfig;
  }

  return {
    name: 'Generalist',
    slug: 'generalist',
    provider: 'openrouter',
    model: 'openrouter/anthropic/claude-sonnet-4',
    system_prompt: 'You are a versatile assistant.',
    tools: ['read_file', 'write_file'],
    workspace: project.repo_path,
    startup_scripts: [],
    token_budget: 4000,
  };
}

function resolveColumnDefault(project: Project, status: string): string | null {
  try {
    const config = JSON.parse(project.config_json) as { column_defaults?: Record<string, string | null> };
    return config.column_defaults?.[status as keyof typeof config.column_defaults] || null;
  } catch {
    return null;
  }
}

function listProjectDocs(repoPath: string): string[] {
  const docsDir = path.join(repoPath, 'project_docs');
  if (!fs.existsSync(docsDir)) return [];

  const result: string[] = [];
  for (const sub of ['specs', 'plans', 'uploads']) {
    const dir = path.join(docsDir, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
      for (const f of files) {
        result.push(path.join('project_docs', sub, f));
      }
    } catch { /* ignore */ }
  }
  return result;
}

export function buildAgentPrompt(ctx: TaskContext): string {
  const parts: string[] = [];

  parts.push(`You are operating as: ${ctx.persona.name}`);
  parts.push(`System: ${ctx.persona.system_prompt}`);
  parts.push('');

  parts.push(`## Project: ${ctx.project.name}`);
  if (ctx.project.description) parts.push(ctx.project.description);
  parts.push(`Working directory: ${ctx.project.repo_path}`);
  parts.push('');

  parts.push(`## Current Task: ${ctx.task.title}`);
  if (ctx.task.description) parts.push(ctx.task.description);
  parts.push(`Status: ${ctx.task.status} | Priority: ${ctx.task.priority}`);
  parts.push('');

  if (ctx.projectDocs.length > 0) {
    parts.push('## Project Documents');
    for (const doc of ctx.projectDocs) {
      parts.push(`- ${doc}`);
    }
    parts.push('');
  }

  if (ctx.otherTasks.length > 0) {
    parts.push('## Other Tasks in Project');
    for (const t of ctx.otherTasks) {
      parts.push(`- [${t.status}] ${t.title} (${t.priority})`);
    }
    parts.push('');
  }

  if (ctx.memoryContext) {
    parts.push(ctx.memoryContext);
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('- Complete this task in the project working directory.');
  parts.push('- Use the project_docs/ directory for reference material, specs, and plans.');
  parts.push('- Write any new specs/plans to project_docs/ as markdown files.');
  parts.push('- When finished, summarize what you did and any decisions made.');
  parts.push('- Include any key insights or decisions in your summary so they can be remembered.');

  return parts.join('\n');
}
