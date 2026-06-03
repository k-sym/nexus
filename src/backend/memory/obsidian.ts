/**
 * Obsidian vault writers for task summaries and chat archives.
 *
 * Memory files and vault-watching are owned by @nexus/memory-daemon now; this module
 * only writes Tasks/ and Chats/ markdown under <vault>/Projects/<slug>/
 * (which the daemon indexes alongside everything else in the shared vault).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Project } from '@nexus/shared';
import { expandHome, loadConfig } from '../config';

export function getVaultPath(): string {
  // Honor the configured vault_path (shared with the daemon) rather than
  // assuming the vault lives under ~/.nexus/obsidian.
  return expandHome(loadConfig().obsidian.vault_path);
}

export function getProjectDir(projectSlug: string): string {
  return path.join(getVaultPath(), 'Projects', projectSlug);
}

export function ensureProjectDir(projectSlug: string): string {
  const dir = getProjectDir(projectSlug);
  for (const sub of ['Tasks', 'Chats', 'Memory', 'Specs']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

export function writeTaskSummary(db: Database.Database, project: Project, taskId: string, title: string, status: string, content: string, agentName?: string): void {
  const dir = ensureProjectDir(project.slug);
  const filePath = path.join(dir, 'Tasks', `${safeFilename(title)}.md`);

  const date = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    '---',
    `date: ${date}`,
    `status: ${status}`,
    `task_id: ${taskId}`,
    agentName ? `agent: ${agentName}` : '',
    '---',
  ].filter(Boolean).join('\n');

  const body = [
    frontmatter,
    '',
    `# ${title}`,
    '',
    content,
  ].join('\n');

  fs.writeFileSync(filePath, body, 'utf-8');
}

export function writeChatArchive(projectSlug: string, title: string, threadId: string, messages: { role: string; content: string; created_at: string }[]): void {
  const dir = ensureProjectDir(projectSlug);
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(/:/g, '-');
  const filePath = path.join(dir, 'Chats', `${date} ${safeFilename(title)}.md`);

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Archived: ${new Date().toISOString()}`);
  lines.push('');

  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Agent**' : '**System**';
    lines.push(`## ${roleLabel} — ${msg.created_at}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function safeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
}
