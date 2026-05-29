/**
 * Memory service (unified facade).
 *
 * Ties the SQLite memory store together with the Obsidian mirror. Provides
 * addMemory (writes to both DB and vault), getRelevantMemories (token-budgeted
 * auto-injection), and lifecycle helpers. Also starts the vault file watcher.
 */
import Database from 'better-sqlite3';
import { Project } from '@nexus/shared';
import { Memory, MemoryInput, createMemory, searchMemories, getAllMemories, deleteMemory, updateMemory, setMemoryEmbedding, getMemoryVectors } from './store';
import { getVaultPath, ensureProjectDir, writeTaskSummary, writeChatArchive, writeMemory, startObsidianWatcher } from './obsidian';
import { embeddingsEnabled, embedTexts, rerankModel, rerank, cosineSimilarity } from './embeddings';
import { loadConfig } from '../config';

export { Memory, MemoryInput, getAllMemories, deleteMemory, updateMemory } from './store';
export { getVaultPath, ensureProjectDir, writeTaskSummary, writeChatArchive, writeMemory } from './obsidian';

export function ensureMemoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      embedding_json TEXT,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
  `);
}

export function initMemorySystem(db: Database.Database): void {
  ensureMemoryTables(db);

  startObsidianWatcher(db, {
    onMemoryEdited: (memoryId: string, content: string) => {
      if (!content) return;
      const existing = db.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId) as { content: string } | undefined;
      // Only write back genuine external edits to known memories.
      if (existing && existing.content !== content) {
        updateMemory(db, memoryId, content);
        console.log('[memory] Synced external edit back to DB:', memoryId);
      }
    },
  });

  console.log('[memory] System initialized');
}

export function addMemory(db: Database.Database, input: MemoryInput): Memory {
  const mem = createMemory(db, input);
  if (input.project_id) {
    const slug = projectSlug(db, input.project_id);
    if (slug) writeMemory(slug, mem.id, mem.content, mem.category);
  }
  // Best-effort, non-blocking embedding so semantic search can find this later.
  // Failures (server down, no model configured) are logged and ignored — the
  // memory still works via lexical fallback.
  if (embeddingsEnabled()) {
    embedTexts([mem.content])
      .then(([vec]) => { if (vec) setMemoryEmbedding(db, mem.id, vec); })
      .catch(err => console.error('[memory] embed-on-write failed:', err.message));
  }
  return mem;
}

/** Look up a project's vault slug from its id. */
export function projectSlug(db: Database.Database, projectId: string): string | null {
  const row = db.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as { slug: string } | undefined;
  return row?.slug ?? null;
}

interface RankedMemory {
  content: string;
  category: string;
}

export async function getRelevantMemories(db: Database.Database, projectId: string, query: string, maxResults?: number, tokenBudget?: number): Promise<string[]> {
  const config = loadConfig();
  const maxMem = maxResults || config.mem0.auto_inject.max_memories;
  const budget = tokenBudget || config.mem0.auto_inject.token_budget;

  let ranked: RankedMemory[] = [];

  // Stage 1: semantic recall + optional rerank, if an embedding model is set.
  if (embeddingsEnabled()) {
    try {
      ranked = await semanticSearch(db, projectId, query, maxMem);
    } catch (err: any) {
      console.error('[memory] semantic search failed, falling back to lexical:', err.message);
      ranked = [];
    }
  }

  // Fallback: lexical TF-IDF (also covers memories not yet embedded).
  if (ranked.length === 0) {
    ranked = searchMemories(db, projectId, query, maxMem).map(m => ({ content: m.content, category: m.category }));
  }

  // Apply the token budget.
  const results: string[] = [];
  let totalTokens = 0;
  for (const mem of ranked) {
    const estimated = estimateTokens(mem.content);
    if (totalTokens + estimated > budget && results.length > 0) break;
    results.push(`[${mem.category}] ${mem.content}`);
    totalTokens += estimated;
  }

  return results;
}

/**
 * Two-stage retrieval: embed the query, take the top candidates by cosine
 * similarity, then (if a reranker is configured) rerank for precision.
 */
async function semanticSearch(db: Database.Database, projectId: string, query: string, maxMem: number): Promise<RankedMemory[]> {
  const [queryVec] = await embedTexts([query]);
  if (!queryVec) return [];

  const embedded = getMemoryVectors(db, projectId).filter(m => m.embedding);
  if (embedded.length === 0) return [];

  // First pass: cosine similarity → top ~20 candidates for the reranker.
  const candidatePoolSize = Math.max(maxMem, 20);
  const byCosine = embedded
    .map(m => ({ m, score: cosineSimilarity(queryVec, m.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePoolSize)
    .map(x => x.m);

  // Second pass: rerank, if configured. On failure, keep the cosine order.
  if (rerankModel()) {
    try {
      const order = await rerank(query, byCosine.map(m => m.content), maxMem);
      return order.map(o => ({ content: byCosine[o.index].content, category: byCosine[o.index].category }));
    } catch (err: any) {
      console.error('[memory] rerank failed, using cosine order:', err.message);
    }
  }

  return byCosine.slice(0, maxMem).map(m => ({ content: m.content, category: m.category }));
}

export function formatMemoryContext(memories: string[]): string {
  if (memories.length === 0) return '';
  return '## Relevant Memories\n' + memories.map(m => `- ${m}`).join('\n');
}

export function getRecentMemories(db: Database.Database, projectId: string, limit = 10): Memory[] {
  return getAllMemories(db, projectId).slice(0, limit);
}

export function compactMemories(db: Database.Database, projectId: string): void {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM memories WHERE project_id = ? AND created_at < ? AND category = ?').run(projectId, thirtyDaysAgo, 'agent_run');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
