#!/usr/bin/env node
/**
 * One-time migration: chat_messages → pi tree-format JSONL session files.
 *
 * Writes canonical pi session files at
 *   ~/.nexus/sessions/{cwd-slug}/{fileTimestamp}_{threadId}.jsonl
 *
 * Each migrated file has the canonical header
 *   { type: "session", version: 1, id: threadId, timestamp, cwd }
 * and one entry per legacy chat_messages row, in tree form
 *   { type: "message", id, parentId, message: {role, content, ...}, timestamp }
 *
 * Idempotent: re-runs overwrite session files and are a no-op for
 * already-migrated rows (gated by user_version >= 100).
 *
 * Schema changes:
 *   v100 (one-shot, run on user_version < 100):
 *     - Add chat_threads.zosma_session_id (UNIQUE) and set it = id
 *     - Drop chat_messages, personas, providers tables
 *   v101 (run on user_version < 101, i.e. also on already-v100 DBs):
 *     - Rebuild chat_threads without the legacy columns
 *       (agent_id, agent_session_id, mode, launch_command). These
 *       were dropped from the new code's INSERTs but the ALTERs
 *       in db.ts never removed them from pre-existing tables, so
 *       the new code's NOT-NULL-less INSERT failed on old DBs.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir();
const DB_PATH = process.env.NEXUS_DB || path.join(HOME, '.nexus', 'nexus.db');
const SESSIONS_DIR = path.join(HOME, '.nexus', 'sessions');

function cwdSlug(repoPath) {
  if (!repoPath) return 'default';
  // Absolute paths: strip the leading slash and keep the rest of the
  // sanitized path. We don't want every absolute path to start with `_`
  // (it would be ugly in the directory tree).
  const cleaned = repoPath.startsWith('/') || repoPath.startsWith('\\')
    ? repoPath.slice(1)
    : repoPath;
  return cleaned.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'default';
}

function safeTimestamp(iso) {
  // pi names session files {fileTimestamp}_{sessionId}.jsonl where
  // fileTimestamp is the session start time with `:` and `.` replaced
  // by `-`. Use the legacy thread's created_at; fallback to now.
  const base = iso ? new Date(iso) : new Date();
  if (isNaN(base.getTime())) return new Date().toISOString().replace(/[:.]/g, '-');
  return base.toISOString().replace(/[:.]/g, '-');
}

function safeIso(ts) {
  if (ts == null) return new Date().toISOString();
  const d = new Date(ts);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No DB at ${DB_PATH} — nothing to migrate.`);
    process.exit(0);
  }
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = OFF');
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  const uv = db.pragma('user_version', { simple: true });
  if (uv >= 101) {
    console.log('Migration already applied (user_version >= 101). Exiting.');
    process.exit(0);
  }

  // Inspect existing schema.
  const threadCols = db.pragma('table_info(chat_threads)').map((c) => c.name);
  const hasProjects = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
    .get();
  if (!hasProjects) {
    console.error('projects table missing — nothing to migrate.');
    process.exit(0);
  }

  const threads = db
    .prepare('SELECT * FROM chat_threads WHERE archived_at IS NULL')
    .all();
  const hasMessages = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'")
    .get();
  const messagesStmt = hasMessages
    ? db.prepare(
        'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC',
      )
    : null;
  let written = 0;
  let skipped = 0;

  for (const thread of threads) {
    const project = db
      .prepare('SELECT repo_path FROM projects WHERE id = ?')
      .get(thread.project_id);
    if (!project || !project.repo_path) {
      skipped++;
      continue;
    }
    const cwd = project.repo_path;
    const messages = messagesStmt ? messagesStmt.all(thread.id) : [];
    const header = {
      type: 'session',
      version: 1,
      id: thread.id,
      timestamp: safeIso(thread.created_at),
      cwd,
    };
    const lines = [JSON.stringify(header)];
    let parentId = null;
    for (const m of messages) {
      const id = m.id;
      const entry = {
        type: 'message',
        id,
        parentId,
        timestamp: safeIso(m.created_at),
        message: {
          role: m.role,
          content: m.content || '',
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(m.tool_calls ? { toolCalls: safeJson(m.tool_calls, []) } : {}),
        },
      };
      lines.push(JSON.stringify(entry));
      parentId = id;
    }
    const dir = path.join(SESSIONS_DIR, cwdSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${safeTimestamp(thread.created_at)}_${thread.id}.jsonl`;
    fs.writeFileSync(path.join(dir, fileName), lines.join('\n') + '\n');
    written++;
  }

  // Schema changes. Wrapped in a transaction so partial state is never
  // persisted if anything throws.
  db.transaction(() => {
    // ── v100: original migration ──
    if (uv < 100) {
      // 1) Add zosma_session_id column + unique index.
      if (!threadCols.includes('zosma_session_id')) {
        db.exec('ALTER TABLE chat_threads ADD COLUMN zosma_session_id TEXT');
        db.exec('UPDATE chat_threads SET zosma_session_id = id');
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_zosma_session ON chat_threads(zosma_session_id)');
      }

      // 2) Drop the legacy tables. SQLite can't drop NOT NULL cleanly, so
      // we just drop the tables outright — no data to preserve.
      db.exec('DROP TABLE IF EXISTS chat_messages');
      db.exec('DROP TABLE IF EXISTS personas');
      db.exec('DROP TABLE IF EXISTS providers');

      db.pragma('user_version = 100');
    }

    // ── v101: rebuild chat_threads without legacy columns ──
    if (uv < 101) {
      const currentCols = db.pragma('table_info(chat_threads)').map((c) => c.name);
      const legacyCols = ['agent_id', 'agent_session_id', 'mode', 'launch_command'];
      const hasLegacy = legacyCols.some((c) => currentCols.includes(c));
      if (hasLegacy) {
        // SQLite can't drop a column with a NOT NULL constraint cleanly
        // (12.x supports DROP COLUMN, but NOT NULL with default-replacement
        // is fragile), so the standard portable approach is the
        // copy-into-new-table dance.
        db.exec(`
          CREATE TABLE chat_threads_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT,
            zosma_session_id TEXT
          );
          INSERT INTO chat_threads_new (id, project_id, title, created_at, updated_at, archived_at, zosma_session_id)
            SELECT id, project_id, title, created_at, updated_at, archived_at, zosma_session_id
            FROM chat_threads;
          DROP TABLE chat_threads;
          ALTER TABLE chat_threads_new RENAME TO chat_threads;
          CREATE INDEX IF NOT EXISTS idx_chat_threads_project ON chat_threads(project_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_zosma_session ON chat_threads(zosma_session_id);
        `);
      }
      db.pragma('user_version = 101');
    }
  })();
  db.pragma('foreign_keys = ON');

  console.log(`Migrated ${written} threads (${skipped} skipped).`);
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

main();
