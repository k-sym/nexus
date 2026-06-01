// FTS5 maintenance. Keyword search is local + instant, so it's updated synchronously
// during ingest — a memory is keyword-searchable the moment it's written.
import type { DB } from "../db/index.js";

export function upsertFts(db: DB, memoryId: string, title: string, body: string): void {
  db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId);
  db.prepare("INSERT INTO memories_fts (memory_id, title, body) VALUES (?, ?, ?)").run(memoryId, title, body);
}

export function deleteFts(db: DB, memoryId: string): void {
  db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId);
}
