/**
 * Memory service (unified facade).
 *
 * Ties the SQLite memory store together with the Obsidian mirror. Provides
 * addMemory (writes to both DB and vault), getRelevantMemories (token-budgeted
 * auto-injection), and lifecycle helpers. Also starts the vault file watcher.
 */
import Database from 'better-sqlite3';
import { Project } from '@nexus/shared';
import { Memory, MemoryInput, createMemory, searchMemories, getAllMemories, deleteMemory, updateMemory } from './store';
import { getVaultPath, ensureProjectDir, writeTaskSummary, writeChatArchive, writeMemory, startObsidianWatcher } from './obsidian';
import { loadConfig, resolveEnvVars } from '../config';

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
    onFileChanged: (vaultPath: string, relativePath: string) => {
      console.log('[memory] Obsidian file changed:', relativePath);
    },
  });

  console.log('[memory] System initialized');
}

export function addMemory(db: Database.Database, input: MemoryInput): Memory {
  const mem = createMemory(db, input);
  if (input.project_id) {
    writeMemory(input.project_id, mem.content, mem.category);
  }
  return mem;
}

export function getRelevantMemories(db: Database.Database, projectId: string, query: string, maxResults?: number, tokenBudget?: number): string[] {
  const config = loadConfig();
  const maxMem = maxResults || config.mem0.auto_inject.max_memories;
  const budget = tokenBudget || config.mem0.auto_inject.token_budget;

  const memories = searchMemories(db, projectId, query, maxMem);
  const results: string[] = [];
  let totalTokens = 0;

  for (const mem of memories) {
    const estimated = estimateTokens(mem.content);
    if (totalTokens + estimated > budget && results.length > 0) break;
    results.push(`[${mem.category}] ${mem.content}`);
    totalTokens += estimated;
  }

  return results;
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
