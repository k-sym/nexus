/**
 * In-app notifications: a small event source for transient toasts (e.g. Jira sync
 * results). The frontend polls listUnseen, renders each as a toast, then marks
 * them seen so they show once.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export type NotificationLevel = 'info' | 'error';

export interface NotificationRow {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  created_at: string;
  seen_at: string | null;
}

const MAX_UNSEEN = 20;

/** Insert a notification and return its id. */
export function insertNotification(
  db: Database.Database,
  n: { level: NotificationLevel; title: string; message: string },
): string {
  const id = uuid();
  db.prepare(
    'INSERT INTO notifications (id, level, title, message, created_at, seen_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(id, n.level, n.title, n.message, new Date().toISOString());
  return id;
}

/** Unseen notifications, most recent first. */
export function listUnseen(db: Database.Database, limit = MAX_UNSEEN): NotificationRow[] {
  return db
    .prepare('SELECT * FROM notifications WHERE seen_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(limit) as NotificationRow[];
}

/** Mark the given ids seen. No-op for an empty list. */
export function markSeen(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE notifications SET seen_at = ? WHERE id = ? AND seen_at IS NULL');
  const tx = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(now, id);
  });
  tx(ids);
}
