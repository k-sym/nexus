/**
 * SQLite database setup and migrations.
 *
 * Opens ~/.nexus/nexus.db, enables WAL + foreign keys, and runs idempotent
 * CREATE TABLE statements plus guarded ALTER TABLE migrations for columns
 * added after a table's original creation. Tables: projects, tasks,
 * chat_threads, chat_messages, agent_runs, tickets (a disposable mirror of
 * Jira tickets assigned to the user; Jira stays canonical).
 * (Memory lives in the standalone @nexus/memory-daemon, not here.)
 *
 * Note: the legacy `personas` and `providers` tables are still referenced
 * by some routes for one more release; they get dropped in the Phase 5
 * migration alongside `chat_messages`.
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
      sort_order INTEGER NOT NULL DEFAULT 0,
      git_remote TEXT NOT NULL DEFAULT '',
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
      thread_id TEXT,
      external_source TEXT,
      external_id TEXT,
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

    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Session',
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
      message_type TEXT NOT NULL DEFAULT 'text',
      structured_json TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      project_id TEXT,
      source TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL,
      output TEXT DEFAULT '',
      error TEXT,
      provider TEXT,
      model TEXT,
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
      models TEXT DEFAULT '[]',
      args TEXT,
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

    CREATE TABLE IF NOT EXISTS braindump_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      project_id TEXT,
      task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Assistant Session',
      remote_session_id TEXT,
      remote_conversation_key TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS assistant_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
      remote_message_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      attachments_json TEXT DEFAULT '[]',
      event_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
      remote_run_id TEXT,
      remote_job_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('chat', 'overnight', 'scheduled')),
      status TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      usage_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      task_id TEXT,
      thread_id TEXT,
      provider TEXT,
      model TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER DEFAULT 0,
      usage_json TEXT,
      last_event TEXT,
      error TEXT,
      diagnostics_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_chat_threads_project ON chat_threads(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_unseen ON notifications(seen_at);
    CREATE INDEX IF NOT EXISTS idx_braindump_status ON braindump_ideas(status);
    CREATE INDEX IF NOT EXISTS idx_assistant_messages_created ON assistant_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_sessions_updated ON assistant_sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_session_messages_session ON assistant_session_messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_runs_session ON assistant_runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_runs_remote ON assistant_runs(remote_run_id);
    CREATE INDEX IF NOT EXISTS idx_assistant_runs_status ON assistant_runs(status);
    CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
    CREATE INDEX IF NOT EXISTS idx_operations_kind ON operations(kind);
    CREATE INDEX IF NOT EXISTS idx_operations_started_at ON operations(started_at);
    CREATE INDEX IF NOT EXISTS idx_operations_project_id ON operations(project_id);
    CREATE INDEX IF NOT EXISTS idx_operations_thread_id ON operations(thread_id);
  `);

  // Memory moved to the standalone @nexus/memory-daemon — drop the legacy in-db table.
  db.exec('DROP TABLE IF EXISTS memories;');

  migrateLegacyAssistantMessages(db);

  const chatCols = db.pragma('table_info(chat_messages)') as { name: string }[];
  if (!chatCols.some((c) => c.name === 'attachments_json')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN attachments_json TEXT DEFAULT \'[]\'');
  }

  const assistantMessageCols = db.pragma('table_info(assistant_session_messages)') as { name: string }[];
  if (!assistantMessageCols.some((c) => c.name === 'attachments_json')) {
    db.exec('ALTER TABLE assistant_session_messages ADD COLUMN attachments_json TEXT DEFAULT \'[]\'');
  }

  const ticketCols = db.pragma('table_info(tickets)') as { name: string }[];
  if (!ticketCols.some((c) => c.name === 'description_adf')) {
    db.exec('ALTER TABLE tickets ADD COLUMN description_adf TEXT');
  }
  if (!ticketCols.some((c) => c.name === 'description_fetched_at')) {
    db.exec('ALTER TABLE tickets ADD COLUMN description_fetched_at TEXT');
  }

  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const hasConfigJson = columns.some(c => c.name === 'config_json');
  if (!hasConfigJson) {
    db.exec('ALTER TABLE projects ADD COLUMN config_json TEXT DEFAULT \'{}\'');
  }
  const hasSortOrder = columns.some(c => c.name === 'sort_order');
  if (!hasSortOrder) {
    db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    const orderedProjects = db.prepare('SELECT id FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE ASC').all() as { id: string }[];
    const updateSortOrder = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
    db.transaction(() => {
      orderedProjects.forEach((project, index) => updateSortOrder.run(index, project.id));
    })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_sort_order ON projects(sort_order)');

  // GitHub issue triage: track the repo on the project, and stamp synced tasks
  // with their source issue so re-syncs dedup regardless of column.
  const projCols2 = db.pragma('table_info(projects)') as { name: string }[];
  if (!projCols2.some((c) => c.name === 'git_remote')) {
    db.exec("ALTER TABLE projects ADD COLUMN git_remote TEXT NOT NULL DEFAULT ''");
  }
  const taskCols2 = db.pragma('table_info(tasks)') as { name: string }[];
  if (!taskCols2.some((c) => c.name === 'external_source')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_source TEXT');
  }
  if (!taskCols2.some((c) => c.name === 'external_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(project_id, external_source, external_id)');

  // Agent run token-tracking migrations (for DBs created before token support).
  const runCols = db.pragma('table_info(agent_runs)') as { name: string }[];
  const runColNames = new Set(runCols.map(c => c.name));
  const runMigrations: Array<[string, string]> = [
    ['provider', 'ALTER TABLE agent_runs ADD COLUMN provider TEXT'],
    ['model', 'ALTER TABLE agent_runs ADD COLUMN model TEXT'],
    ['duration_ms', 'ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER DEFAULT 0'],
  ];
  // Existing DBs created before the token-tracking strip may still have
  // these columns. Drop them now so the schema matches the CREATE TABLE
  // above. SQLite 3.35+ (bundled in better-sqlite3@^12) supports DROP COLUMN.
  const tokenColumnsToDrop = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  for (const col of tokenColumnsToDrop) {
    if (runColNames.has(col)) {
      db.exec(`ALTER TABLE agent_runs DROP COLUMN ${col}`);
    }
  }
  for (const [col, sql] of runMigrations) {
    if (!runColNames.has(col)) {
      db.exec(sql);
    }
  }

  // agent_runs: allow chat-turn usage rows (task_id nullable) + project_id/source
  // for scoping. SQLite can't drop NOT NULL in place, so recreate when the new
  // `source` column is absent. Existing task rows keep their task_id and get
  // project_id backfilled from their task.
  if (!runColNames.has('source')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_runs_new (
          id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          project_id TEXT,
          source TEXT NOT NULL DEFAULT 'task',
          status TEXT NOT NULL,
          output TEXT DEFAULT '',
          error TEXT,
          provider TEXT,
          model TEXT,
          duration_ms INTEGER DEFAULT 0,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO agent_runs_new (id, task_id, status, output, error, provider, model, duration_ms, started_at, completed_at)
          SELECT id, task_id, status, output, error, provider, model, duration_ms, started_at, completed_at FROM agent_runs;
        DROP TABLE agent_runs;
        ALTER TABLE agent_runs_new RENAME TO agent_runs;
        UPDATE agent_runs SET project_id = (SELECT project_id FROM tasks WHERE tasks.id = agent_runs.task_id) WHERE task_id IS NOT NULL;
      `);
    })();
    db.pragma('foreign_keys = ON');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)');
  }
  // project_id index for both fresh DBs (table created with the column) and
  // recreated ones. Runs after the table is guaranteed to have the column.
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id)');

  // Task model picker — user-picked `provider/id` set by the orchestrator's
  // "In Progress" model-picker flow. Tasks without a model_key sit idle
  // until the picker runs.
  const taskCols = db.pragma('table_info(tasks)') as { name: string }[];
  if (!taskCols.some((c) => c.name === 'model_key')) {
    db.exec('ALTER TABLE tasks ADD COLUMN model_key TEXT');
  }
  // Task ↔ chat link — moving a task to "In Progress" now opens an
  // interactive chat thread (replacing headless dispatch). The thread id
  // is stored here so clicking the card reopens its conversation.
  if (!taskCols.some((c) => c.name === 'thread_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN thread_id TEXT');
  }

  // Chat thread model persistence — remember which model was last used
  // per thread so the UI can restore it when switching back.
  const threadCols = db.pragma('table_info(chat_threads)') as { name: string }[];
  if (!threadCols.some((c) => c.name === 'last_model_key')) {
    db.exec('ALTER TABLE chat_threads ADD COLUMN last_model_key TEXT');
  }

  // Mission scheduler — bounded recurring missions and their run history.
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'echo',
      config_json TEXT NOT NULL DEFAULT '{}',
      pacing TEXT NOT NULL DEFAULT 'fixed',
      interval_seconds INTEGER NOT NULL DEFAULT 3600,
      max_iterations INTEGER,
      max_wall_clock_seconds INTEGER,
      max_tokens INTEGER,
      run_window_start TEXT,
      run_window_end TEXT,
      status TEXT NOT NULL DEFAULT 'paused',
      iteration_count INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      started_at TEXT,
      last_run_at TEXT,
      stopped_at TEXT,
      stop_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_missions_project ON missions(project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_missions_status_due ON missions(status, next_run_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS mission_runs (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      run_number INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT '',
      selected_work_json TEXT,
      result_summary TEXT NOT NULL DEFAULT '',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      next_run_at TEXT,
      stop_reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mission_runs_mission ON mission_runs(mission_id, run_number)');
}

function migrateLegacyAssistantMessages(db: Database.Database): void {
  const legacyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_messages'")
    .get();
  if (!legacyTable) return;

  const legacyCount = (db.prepare('SELECT COUNT(*) AS count FROM assistant_messages').get() as { count: number }).count;
  if (legacyCount === 0) return;

  const sessionCount = (db.prepare('SELECT COUNT(*) AS count FROM assistant_sessions').get() as { count: number }).count;
  if (sessionCount > 0) return;

  const bounds = db
    .prepare('SELECT MIN(created_at) AS first_created_at, MAX(created_at) AS last_created_at FROM assistant_messages')
    .get() as { first_created_at: string | null; last_created_at: string | null };
  const now = new Date().toISOString();
  const sessionId = 'legacy-assistant-import';
  const createdAt = bounds.first_created_at ?? now;
  const updatedAt = bounds.last_created_at ?? createdAt;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO assistant_sessions
        (id, title, status, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(sessionId, 'Imported Assistant Session', 'idle', createdAt, updatedAt);

    db.prepare(
      `INSERT OR IGNORE INTO assistant_session_messages
        (id, session_id, remote_message_id, role, content, attachments_json, event_json, created_at)
       SELECT id, ?, NULL, role, content, '[]', NULL, created_at
       FROM assistant_messages
       ORDER BY created_at ASC`,
    ).run(sessionId);
  })();
}
