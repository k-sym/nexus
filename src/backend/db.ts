/**
 * SQLite database setup and migrations.
 *
 * Opens ~/.nexus/nexus.db, enables WAL + foreign keys, and runs idempotent
 * CREATE TABLE statements plus guarded ALTER TABLE migrations for columns
 * added after a table's original creation. Tables: projects, tasks, personas,
 * schedules, chat_threads, chat_messages, agent_runs, tickets (a disposable
 * mirror of Jira tickets assigned to the user; Jira stays canonical). (Memory
 * lives in the standalone @nexus/memory-daemon, not here.)
 */
import Database from 'better-sqlite3';

export function getDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent TEXT,
      due_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      config_yaml TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      task_template TEXT NOT NULL,
      task_description TEXT DEFAULT '',
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      attachments_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      output TEXT DEFAULT '',
      error TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      default_model TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      key TEXT PRIMARY KEY,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT DEFAULT '',
      priority TEXT DEFAULT '',
      assignee TEXT,
      created TEXT,
      updated TEXT,
      url TEXT,
      source TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_chat_threads_project ON chat_threads(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  `);

  // Memory moved to the standalone @nexus/memory-daemon — drop the legacy in-db table.
  db.exec('DROP TABLE IF EXISTS memories;');

  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const hasConfigJson = columns.some(c => c.name === 'config_json');
  if (!hasConfigJson) {
    db.exec('ALTER TABLE projects ADD COLUMN config_json TEXT DEFAULT \'{}\'');
  }

  // Schedule table migrations (for DBs created before scheduler support).
  const schedCols = db.pragma('table_info(schedules)') as { name: string }[];
  const schedColNames = new Set(schedCols.map(c => c.name));
  const schedMigrations: Array<[string, string]> = [
    ['project_id', "ALTER TABLE schedules ADD COLUMN project_id TEXT DEFAULT ''"],
    ['task_description', "ALTER TABLE schedules ADD COLUMN task_description TEXT DEFAULT ''"],
    ['next_run', 'ALTER TABLE schedules ADD COLUMN next_run TEXT'],
  ];
  for (const [col, sql] of schedMigrations) {
    if (!schedColNames.has(col)) {
      db.exec(sql);
    }
  }

  // Agent run token-tracking migrations (for DBs created before token support).
  const runCols = db.pragma('table_info(agent_runs)') as { name: string }[];
  const runColNames = new Set(runCols.map(c => c.name));
  const runMigrations: Array<[string, string]> = [
    ['provider', 'ALTER TABLE agent_runs ADD COLUMN provider TEXT'],
    ['model', 'ALTER TABLE agent_runs ADD COLUMN model TEXT'],
    ['prompt_tokens', 'ALTER TABLE agent_runs ADD COLUMN prompt_tokens INTEGER DEFAULT 0'],
    ['completion_tokens', 'ALTER TABLE agent_runs ADD COLUMN completion_tokens INTEGER DEFAULT 0'],
    ['total_tokens', 'ALTER TABLE agent_runs ADD COLUMN total_tokens INTEGER DEFAULT 0'],
    ['duration_ms', 'ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER DEFAULT 0'],
  ];
  for (const [col, sql] of runMigrations) {
    if (!runColNames.has(col)) {
      db.exec(sql);
    }
  }
}
