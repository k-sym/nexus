-- Nexus memory daemon — SQLite index schema.
-- This index is DISPOSABLE: it can be deleted and fully rebuilt from the markdown vault.
-- All vectors are 768-dim (nomic-embed-text-v1.5 @ 127.0.0.1:4002).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ── Canonical memory rows (mirror of one markdown file each) ──────────────────
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,          -- ULID, also lives in the file's frontmatter
  namespace        TEXT NOT NULL,             -- nexus | openclaw | global
  project          TEXT,                      -- project slug (nullable)
  category         TEXT,                      -- general|decision|chat|agent_run|specs|...
  source           TEXT NOT NULL,             -- nexus|openclaw|human|orchestrator
  title            TEXT,
  body             TEXT NOT NULL,
  frontmatter_json TEXT,                       -- full frontmatter as JSON (lossless round-trip)
  file_path        TEXT NOT NULL UNIQUE,       -- absolute path within the vault
  content_hash     TEXT NOT NULL,             -- hash of canonical serialized file (loop suppression)
  file_mtime       INTEGER NOT NULL,          -- ms epoch of file at last index
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT                        -- soft delete (file unlinked)
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(namespace, project, category);
CREATE INDEX IF NOT EXISTS idx_memories_live  ON memories(deleted_at);

-- ── Chunks (300-word windows, 80-word overlap) ────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  seg_hash   TEXT NOT NULL,                    -- FNV-1a of text (embedding dedup)
  embedded   INTEGER NOT NULL DEFAULT 0        -- 0 until its vector is written
);
CREATE INDEX IF NOT EXISTS idx_chunks_memory ON chunks(memory_id);

-- ── Sentences (deep index; ≥5 chars) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sentences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  seg_hash   TEXT NOT NULL,
  embedded   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sentences_memory ON sentences(memory_id);
CREATE INDEX IF NOT EXISTS idx_sentences_chunk  ON sentences(chunk_id);

-- ── Vector tables (sqlite-vec vec0; rowid joins back to chunks/sentences) ──────
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec    USING vec0(embedding float[768]);
CREATE VIRTUAL TABLE IF NOT EXISTS sentence_vec USING vec0(embedding float[768]);

-- ── Embedding dedup cache (FNV-1a seg_hash -> vector). Lets re-saves and ──────
-- ── repeated segments skip the embedder entirely. ────────────────────────────
CREATE TABLE IF NOT EXISTS embed_cache (
  seg_hash   TEXT PRIMARY KEY,
  vec        BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- ── Keyword search (FTS5, porter + prefix); memory_id carried UNINDEXED ───────
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61',
  prefix = '2 3 4'
);

-- ── Knowledge-graph triples (Phase 5; table defined now) ──────────────────────
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  subj_type  TEXT,
  relation   TEXT NOT NULL,
  object     TEXT NOT NULL,
  obj_type   TEXT,
  confidence REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_memory  ON facts(memory_id);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS idx_facts_object  ON facts(object);

-- ── Background job queue (dead-letter + ghost recovery) ───────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,                  -- deep_index | extract_kg | reindex_memory
  payload      TEXT NOT NULL,                  -- JSON
  status       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|PROCESSING|DONE|DEAD
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error   TEXT,
  run_after    TEXT NOT NULL,                  -- ISO; backoff gate
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after);

-- ── Sync state (loop suppression + change detection) ──────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  file_path         TEXT PRIMARY KEY,
  memory_id         TEXT,
  last_written_hash TEXT,                       -- hash the daemon last WROTE (echo detection)
  last_mtime        INTEGER,
  last_indexed_at   TEXT
);

-- ── Audit / provenance ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oplog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  op         TEXT NOT NULL,                     -- ingest|update|delete|reindex|conflict|...
  memory_id  TEXT,
  source     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_oplog_ts ON oplog(ts);
