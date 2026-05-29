/**
 * Obsidian vault sync.
 *
 * Writes memories, task summaries, and chat archives as markdown (with YAML
 * frontmatter) under ~/.nexus/obsidian/Projects/<slug>/. A chokidar watcher
 * detects external edits to memory files for bidirectional sync.
 */
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import Database from 'better-sqlite3';
import { Project } from '@nexus/shared';
import { getNexusDir } from '../config';

interface ObsidianSyncCallbacks {
  /** Fired when an externally-edited memory markdown file changes. */
  onMemoryEdited: (memoryId: string, content: string) => void;
}

export function getVaultPath(): string {
  return path.join(getNexusDir(), 'obsidian');
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

export function writeMemory(projectSlug: string, memoryId: string, content: string, category: string): void {
  const dir = ensureProjectDir(projectSlug);
  // Filename is keyed on the memory id so updates overwrite the same file
  // rather than accumulating duplicates.
  const filePath = path.join(dir, 'Memory', `${memoryId}.md`);

  const body = [
    `---`,
    `id: ${memoryId}`,
    `category: ${category}`,
    `date: ${new Date().toISOString()}`,
    `---`,
    '',
    content,
  ].join('\n');

  fs.writeFileSync(filePath, body, 'utf-8');
}

export function startObsidianWatcher(db: Database.Database, callbacks: ObsidianSyncCallbacks): void {
  const vaultPath = getVaultPath();

  const watcher = chokidar.watch(vaultPath, {
    ignored: /(^|[\/\\])\.|node_modules/,
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', (filePath: string) => {
    if (!filePath.endsWith('.md')) return;
    // Only memory files (which carry an `id` in their frontmatter) sync back.
    const parsed = parseMarkdown(filePath);
    if (parsed.frontmatter.id) {
      callbacks.onMemoryEdited(parsed.frontmatter.id, parsed.body.trim());
    }
  });

  console.log('[memory] Obsidian vault watcher started');
}

/** Split a markdown file into its YAML frontmatter map and remaining body. */
function parseMarkdown(filePath: string): { frontmatter: Record<string, string>; body: string } {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: raw };
    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: {}, body: '' };
  }
}

function safeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
}
