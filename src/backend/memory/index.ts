/**
 * Memory service facade.
 *
 * Memory is owned by the standalone @nexus/memory-daemon (markdown-canonical vault +
 * rebuildable sqlite-vec/FTS5 index, hybrid retrieval + KG). This module keeps the
 * function signatures the rest of the backend already uses, but routes every call to
 * the daemon over HTTP (see ./client). The daemon must be running for memory to work;
 * if it's unreachable, memory reads degrade to empty and writes are best-effort.
 *
 * `nexus.db` no longer stores memories. Task summaries and chat archives are still
 * written to the vault as plain markdown by ./obsidian (the daemon indexes them too).
 */
import Database from 'better-sqlite3';
import { daemon, DaemonRecallItem } from './client.js';

export { writeTaskSummary, writeChatArchive, getVaultPath, ensureProjectDir } from './obsidian.js';

/** Memory shape returned to the frontend list view (daemon-backed). */
export interface Memory {
  id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryInput {
  project_id: string;
  agent_id?: string;
  category?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Look up a project's vault slug (the daemon scopes nexus memories by slug). */
export function projectSlug(db: Database.Database, projectId: string): string | null {
  const row = db.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as { slug: string } | undefined;
  return row?.slug ?? null;
}

/** Verify the daemon is reachable at boot (warn, don't crash, if it isn't). */
export async function initMemorySystem(_db: Database.Database): Promise<void> {
  try {
    const h = await daemon.health();
    console.log(`[memory] daemon reachable (${h.status})`);
  } catch (err: any) {
    console.warn(`[memory] daemon unreachable at boot — memory features will be inert until it starts: ${err.message}`);
  }
}

/** Store a memory in the daemon (writes the canonical vault file + indexes it). */
export async function addMemory(db: Database.Database, input: MemoryInput): Promise<{ id: string } | null> {
  const slug = projectSlug(db, input.project_id);
  try {
    return await daemon.store({
      namespace: 'nexus',
      project: slug,
      category: input.category || 'general',
      source: input.agent_id ? `nexus:${input.agent_id}` : 'nexus',
      body: input.content,
    });
  } catch (err: any) {
    console.error('[memory] store failed:', err.message);
    return null;
  }
}

function formatItem(item: DaemonRecallItem): string {
  const text = item.sentences.map(s => s.text).join(' ').trim();
  if (!text) return item.title || '';
  // Avoid "Title: Title" when the daemon derived the title from the same text.
  if (!item.title || text.includes(item.title)) return text;
  return `${item.title}: ${text}`;
}

function contentFromRecallItem(item: DaemonRecallItem): string {
  return (item.body ?? item.parentChunks?.[0] ?? item.sentences.map(s => s.text).join(' ') ?? item.title ?? '').trim();
}

function mapRecallItem(projectId: string, item: DaemonRecallItem): Memory {
  const timestamp = item.updated_at ?? item.created_at ?? new Date(0).toISOString();
  return {
    id: item.id,
    project_id: projectId,
    category: item.category || 'general',
    title: item.title || '',
    content: contentFromRecallItem(item),
    source: item.source,
    created_at: item.created_at ?? timestamp,
    updated_at: timestamp,
  };
}

/** Default cap on memories returned by a single recall. */
export const DEFAULT_RECALL_LIMIT = 5;
/** Default hard cap on the tokens a single recall may return. */
export const DEFAULT_RECALL_TOKEN_BUDGET = 1000;

/**
 * Token-budgeted recall. Returns formatted strings ready to hand to a model.
 *
 * This is pull-based, not push-based: the agent calls the `memory_recall` tool
 * (see ../pi/memory-tool.ts) when it decides memory is relevant. Recall runs
 * HyDE in the daemon and costs seconds, so it is deliberately not injected into
 * every turn.
 */
export async function getRelevantMemories(
  db: Database.Database,
  projectId: string,
  query: string,
  maxResults?: number,
  tokenBudget?: number,
): Promise<string[]> {
  if (!query || query.trim().length === 0) return [];
  const max = maxResults || DEFAULT_RECALL_LIMIT;
  const budget = tokenBudget || DEFAULT_RECALL_TOKEN_BUDGET;
  const slug = projectSlug(db, projectId);

  let items: DaemonRecallItem[] = [];
  try {
    const res = await daemon.recall(query, { namespace: 'nexus', project: slug, scope: 'isolated' }, max);
    items = res.items;
  } catch (err: any) {
    console.error('[memory] recall failed:', err.message);
    return [];
  }

  const results: string[] = [];
  let totalTokens = 0;
  for (const item of items) {
    const text = formatItem(item);
    if (!text) continue;
    const estimated = Math.ceil(text.split(/\s+/).length * 1.3);
    if (totalTokens + estimated > budget && results.length > 0) break;
    results.push(text);
    totalTokens += estimated;
    if (results.length >= max) break;
  }
  return results;
}

/**
 * Recall scoped to whatever project owns `repoPath`.
 *
 * Pi sessions are keyed by cwd, not project id, so the `memory_recall` tool
 * resolves its project this way. Returns [] for a cwd that isn't a known
 * project — an untracked directory has no project memories to recall.
 */
export async function recallForRepoPath(
  db: Database.Database,
  repoPath: string,
  query: string,
  maxResults?: number,
): Promise<string[]> {
  const row = db.prepare('SELECT id FROM projects WHERE repo_path = ?').get(repoPath) as { id: string } | undefined;
  if (!row) return [];
  return getRelevantMemories(db, row.id, query, maxResults);
}

/** Search memories for the management UI. Unlike recall injection, this preserves IDs. */
export async function searchMemoryRecords(db: Database.Database, projectId: string, query: string): Promise<Memory[]> {
  if (!query || query.trim().length === 0) return [];
  const slug = projectSlug(db, projectId);

  try {
    const res = await daemon.search(query, { namespace: 'nexus', project: slug, scope: 'isolated' }, 50);
    return res.items.map(item => mapRecallItem(projectId, item)).filter(item => item.content || item.title);
  } catch (err: any) {
    console.error('[memory] UI search failed:', err.message);
    return [];
  }
}

/** List recent memories for a project (frontend list view). */
export async function getAllMemories(db: Database.Database, projectId: string): Promise<Memory[]> {
  const slug = projectSlug(db, projectId);
  try {
    const res = await daemon.list({ namespace: 'nexus', project: slug }, 100);
    return res.items.map(m => ({
      id: m.id,
      project_id: projectId,
      category: m.category || 'general',
      title: m.title || '',
      content: (m.body || m.title || '').trim(),
      source: m.source,
      created_at: m.created_at ?? m.updated_at,
      updated_at: m.updated_at,
    }));
  } catch (err: any) {
    console.error('[memory] list failed:', err.message);
    return [];
  }
}

export async function updateMemory(_db: Database.Database, id: string, content: string): Promise<void> {
  await daemon.update(id, { body: content });
}

export async function deleteMemory(_db: Database.Database, id: string): Promise<void> {
  await daemon.remove(id);
}

export function formatMemoryContext(memories: string[]): string {
  if (memories.length === 0) return '';
  return '## Relevant Memories\n' + memories.map(m => `- ${m}`).join('\n');
}
