/**
 * Memory store (SQLite + lexical search).
 *
 * CRUD over the `memories` table plus a dependency-free TF-IDF-style search
 * (tokenize, drop stop-words, score by query-term frequency). Designed so a
 * vector-search path can be added later without changing the public API.
 */
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface Memory {
  id: string;
  project_id: string;
  agent_id: string | null;
  category: string;
  content: string;
  embedding: number[] | null;
  metadata_json: string;
  created_at: string;
}

export interface MemoryInput {
  project_id: string;
  agent_id?: string;
  category?: string;
  content: string;
  embedding?: number[];
  metadata?: Record<string, string>;
}

export function createMemory(db: Database.Database, input: MemoryInput): Memory {
  const mem: Memory = {
    id: uuid(),
    project_id: input.project_id,
    agent_id: input.agent_id || null,
    category: input.category || 'general',
    content: input.content,
    embedding: input.embedding || null,
    metadata_json: JSON.stringify(input.metadata || {}),
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO memories (id, project_id, agent_id, category, content, embedding_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mem.id, mem.project_id, mem.agent_id, mem.category, mem.content,
       mem.embedding ? JSON.stringify(mem.embedding) : null,
       mem.metadata_json, mem.created_at);

  return mem;
}

export function searchMemories(db: Database.Database, projectId: string, query: string, limit = 5): Memory[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const all = db.prepare(
    'SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(projectId) as Memory[];

  const scored = all.map(mem => ({
    mem,
    score: relevanceScore(mem.content, tokens),
  }));

  scored.sort((a, b) => b.score - a.score);

  const top = scored.filter(s => s.score > 0).slice(0, limit);
  return top.length > 0 ? top.map(s => s.mem) : all.slice(0, limit);
}

export function getMemoriesByCategory(db: Database.Database, projectId: string, category: string): Memory[] {
  return db.prepare(
    'SELECT * FROM memories WHERE project_id = ? AND category = ? ORDER BY created_at DESC'
  ).all(projectId, category) as Memory[];
}

export function getAllMemories(db: Database.Database, projectId: string): Memory[] {
  return db.prepare(
    'SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId) as Memory[];
}

export function deleteMemory(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function updateMemory(db: Database.Database, id: string, content: string): void {
  db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id);
}

// ---- Full text search helpers

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'in', 'it', 'of', 'to', 'for', 'on', 'with', 'this', 'that', 'we', 'i', 'you', 'not', 'was', 'are', 'has', 'had', 'at', 'be', 'do', 'will', 'can', 'would', 'could', 'should', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'from', 'by', 'as', 'if', 'no', 'yes', 'so', 'than', 'too', 'very', 'just', 'about', 'up', 'out', 'my', 'your', 'their', 'its', 'our']);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function relevanceScore(content: string, queryTokens: string[]): number {
  const contentTokens = tokenize(content);
  const contentFreq: Record<string, number> = {};
  for (const t of contentTokens) {
    contentFreq[t] = (contentFreq[t] || 0) + 1;
  }

  let score = 0;
  for (const qt of queryTokens) {
    if (contentFreq[qt]) {
      score += contentFreq[qt];
    }
  }
  return score;
}
