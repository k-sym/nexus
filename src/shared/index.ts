/**
 * Shared types for the Nexus backend and frontend.
 *
 * The chat runtime is now the pi-coding-agent SDK; persona/provider/PTY
 * surfaces are gone. Only the types the new code paths still need are
 * exported.
 */

export type TaskStatus = 'triage' | 'todo' | 'in_progress' | 'review' | 'deploy';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** Max characters in a project rail badge. */
export const PROJECT_BADGE_MAX_LENGTH = 3;

/** Connector words that shouldn't win an initial in a derived badge. */
const BADGE_STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by']);

/**
 * Default rail badge for a project name: up to three characters, uppercase.
 *
 * Multi-word names collapse to initials ("United States of America" -> USA,
 * connector words ignored); a single word takes its first three letters
 * ("Nexus" -> NEX). Two-word names legitimately yield two characters. This is
 * only a starting point — the badge is user-editable, so a name whose initials
 * read badly can be fixed by hand rather than by a cleverer rule here.
 */
export function deriveProjectBadge(name: string): string {
  const words = name.match(/[a-z0-9]+/gi) ?? [];
  if (words.length === 0) return '?';
  // Drop connectors only while at least two real words survive, so "Of Mice"
  // doesn't strip itself down to nothing.
  const significant = words.filter((w) => !BADGE_STOPWORDS.has(w.toLowerCase()));
  const chosen = significant.length >= 2 ? significant : words;
  if (chosen.length >= 2) {
    return chosen.slice(0, PROJECT_BADGE_MAX_LENGTH).map((w) => w[0]).join('').toUpperCase();
  }
  return chosen[0].slice(0, PROJECT_BADGE_MAX_LENGTH).toUpperCase();
}

/**
 * Coerce user input into a storable badge, falling back to the derived value
 * when the field is left empty or contains nothing usable.
 */
export function normalizeProjectBadge(value: string | undefined, name = ''): string {
  const cleaned = (value ?? '').replace(/[^a-z0-9]/gi, '').slice(0, PROJECT_BADGE_MAX_LENGTH).toUpperCase();
  return cleaned || deriveProjectBadge(name);
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  /** Up to 3 uppercase chars shown in the project rail; derived from name, user-editable. */
  badge: string;
  /** @deprecated No longer surfaced in the UI — superseded by `badge`. Retained so existing rows keep their data. */
  description: string;
  repo_path: string;
  config_json: string;
  /** Detected `git remote origin` URL of repo_path; '' when none/not a git repo. */
  git_remote: string;
  task_count?: number;
  chat_session_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Persona slug from the legacy persona system. Retained on the row so
   *  legacy data doesn't break; the new orchestrator doesn't read it. */
  assigned_agent: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  /** Model picked when the task was moved to "In Progress" (provider/id).
   *  Seeds the linked chat thread's first turn. */
  model_key: string | null;
  /** The chat thread this task runs in. Set when the task is moved to
   *  "In Progress" and a model is picked; the agent works in that thread
   *  instead of running headlessly. Null for tasks never started. */
  thread_id: string | null;
  /** Source system for an auto-triaged task, e.g. 'github'. Null for manual tasks. */
  external_source: string | null;
  /** Identifier within the source system, e.g. the GitHub issue number as text.
   *  Paired with external_source to dedup re-syncs. Null for manual tasks. */
  external_id: string | null;
}

export interface GitDiffSummary {
  files: number;
  hunks: number;
  added: number;
  deleted: number;
  staged_files: string[];
  unstaged_files: string[];
  untracked_files: string[];
}

export interface GitDiffFile {
  path: string;
  old_path: string | null;
  new_path: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';
  added: number;
  deleted: number;
  staged: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffHunk {
  id: string;
  file: string;
  header: string;
  diff: string;
  prompt: string;
  staged: boolean;
  old_start: number | null;
  new_start: number | null;
  old_lines: number | null;
  new_lines: number | null;
}

export type GitDiffState =
  | {
      ok: true;
      repo_path: string;
      git_remote: string;
      has_changes: boolean;
      summary: GitDiffSummary;
      files: GitDiffFile[];
      hunks: GitDiffHunk[];
    }
  | {
      ok: false;
      reason: 'not_git_repo' | 'git_error';
      message: string;
      repo_path?: string;
      git_remote?: string;
    };

export type ReviewAction = 'ask_reviewer' | 'explain_change' | 'spawn_fix_task' | 'assign_reviewer' | 'attach_to_chat';

export interface ReviewActionRequest {
  task_id?: string;
  action: ReviewAction;
  hunk_id?: string;
  note?: string;
}

export interface ReviewActionResult {
  ok: true;
  action: ReviewAction;
  task?: {
    id: string;
    project_id: string;
    title: string;
    status: TaskStatus;
    assigned_agent: string | null;
    model_key: string | null;
  };
  thread?: {
    id: string;
    project_id: string;
    title: string;
  };
  seed?: {
    threadId: string;
    prompt: string;
    modelKey: string | null;
  };
}

/** A Jira ticket mirrored into Nexus (Jira stays canonical). */
export interface Ticket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  assignee: string | null;
  created: string | null;
  updated: string | null;
  url: string | null;
  source: string | null;
  synced_at: string;
}

/** Cleaned, display-ready body of a Jira ticket, fetched lazily on selection. */
export interface TicketDescription {
  key: string;
  /** Readable plain text: paragraphs separated by blank lines, list items as "• …". Empty string when the ticket has no description. */
  body: string;
  /** Sections pulled out of the body and offered behind a "show more" fold. */
  trimmed: { kind: 'forwarded' | 'footer'; text: string }[];
  /** ISO timestamp the body was last fetched from Jira; null if never fetched. */
  fetchedAt: string | null;
  /** True when Jira returned no description content for this ticket. */
  empty: boolean;
}

/** A free-form idea captured in the Braindump view before it becomes a project task. */
export interface BraindumpIdea {
  id: string;
  title: string;
  body: string;
  status: 'active' | 'triaged';
  /** Set when triaged into a project. */
  project_id: string | null;
  /** The task created on triage. */
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

export type MissionStatus = 'paused' | 'active' | 'stopped';
export type MissionPacing = 'fixed' | 'self_paced' | 'backlog_drain';
export type MissionStopReason =
  | 'manual'
  | 'max_iterations'
  | 'max_wall_clock'
  | 'token_budget'
  | 'drained'
  | 'error';
export type MissionKind = 'echo' | 'triage_tickets' | 'review_stale_tasks' | 'assistant_turn';
export type MissionRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface Mission {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: MissionKind;
  config_json: string;
  pacing: MissionPacing;
  interval_seconds: number;
  max_iterations: number | null;
  max_wall_clock_seconds: number | null;
  max_tokens: number | null;
  run_window_start: string | null; // 'HH:MM' local
  run_window_end: string | null;   // 'HH:MM' local
  status: MissionStatus;
  iteration_count: number;
  tokens_used: number;
  next_run_at: string | null;
  started_at: string | null;
  last_run_at: string | null;
  stopped_at: string | null;
  stop_reason: MissionStopReason | null;
  created_at: string;
  updated_at: string;
}

export interface MissionRun {
  id: string;
  mission_id: string;
  run_number: number;
  started_at: string;
  completed_at: string | null;
  status: MissionRunStatus;
  intent: string;
  selected_work_json: string | null;
  result_summary: string;
  tokens_used: number;
  error: string | null;
  next_run_at: string | null;
  stop_reason: MissionStopReason | null;
  created_at: string;
}

export interface CreateMissionInput {
  title: string;
  description?: string;
  kind?: MissionKind;
  config?: Record<string, unknown>;
  pacing?: MissionPacing;
  interval_seconds?: number;
  max_iterations?: number | null;
  max_wall_clock_seconds?: number | null;
  max_tokens?: number | null;
  run_window_start?: string | null;
  run_window_end?: string | null;
}

export type UpdateMissionInput = Partial<CreateMissionInput>;

/** A chat thread — one conversation per row, linked to a project. */
export interface ChatThread {
  id: string;
  project_id: string;
  title: string;
  /** Current branch of the project checkout when the thread list was loaded. Empty when unavailable. */
  git_branch?: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SignalFilterFlags {
  ansi: boolean;
  progress: boolean;
  repeated_lines: boolean;
  package_manager: boolean;
  test_output: boolean;
  stack_trace: boolean;
  diff_context: boolean;
}

export interface SignalFilterProjectOverride {
  enabled?: boolean;
  min_input_bytes?: number;
  max_output_bytes?: number;
  filters?: Partial<SignalFilterFlags>;
}

export interface SignalFilterConfig {
  enabled: boolean;
  min_input_bytes: number;
  max_output_bytes: number;
  filters: SignalFilterFlags;
  projects: Record<string, SignalFilterProjectOverride>;
}

export interface NexusConfig {
  server: {
    /** Local port the backend binds (loopback). */
    port: number;
    /** Remote backend base URL for thin-client mode (e.g. the Tailscale host,
     *  including any TLS port — `/api` is appended by the frontend). Empty or a
     *  loopback URL ⇒ full-stack: the desktop shell spawns a local backend.
     *  A remote (non-loopback) URL ⇒ the shell probes it, spawns nothing, and
     *  points the frontend's window.__NEXUS_API__ here. Mirrors memory.daemon_url. */
    url?: string;
    /** Bearer token gating the backend's /api/* (except /api/health). Supports
     *  ${ENV} interpolation; empty ⇒ dev-open (no auth). Mirrors gateway.token. */
    token?: string;
  };
  /** LAN gateway that serves the Even Realities G2 glasses cockpit
   *  (session-cockpit) the Nexus session feed + control API. */
  gateway: {
    /** When false the glasses gateway listener is not started. */
    enabled: boolean;
    /** LAN port the glasses connect to. Matches session-cockpit's default (8899). */
    port: number;
    /** Bearer token the glasses must present. Empty ⇒ dev-open (no auth). */
    token: string;
    /** Window (minutes) within which an idle session still counts as "recent"
     *  and is listed so it can be opened/steered from the glasses. */
    recent_minutes: number;
    /** Absolute path to the built glasses UI (session-cockpit/glasses/dist).
     *  When set, the gateway serves that SPA at `/` so the whole cockpit —
     *  UI + API — is one Nexus origin. Empty ⇒ API only. Env override:
     *  NEXUS_GLASSES_DIST. */
    glasses_dist: string;
    /** Speech-to-text for glasses voice steer/answer. Delivered to the glasses
     *  via GET /api/cockpit-config so the key lives here, not in the client.
     *  api_key supports ${ENV} interpolation; empty ⇒ voice disabled. */
    stt: {
      provider: string; // 'deepgram' | 'whisper-api' | 'soniox'
      api_key: string;
      language: string;
    };
  };
  models: {
    openrouter: { api_key: string };
    // Local OpenAI-compatible server. base_url should include the /v1 suffix,
    // e.g. http://localhost:8000/v1 for omlx. embedding_model / rerank_model
    // are optional; empty means that capability is disabled (memory falls back
    // to lexical TF-IDF search).
    local: {
      base_url: string;
      api_key: string;
      display_name: string;
      chat_model: string;
      supports_images: boolean;
      embedding_model: string;
      rerank_model: string;
    };
  };
  assistant: {
    /** OpenAI-compatible remote assistant endpoint, e.g. Hermes/OpenClaw. */
    url: string;
    /** Supports ${ASSISTANT_API_KEY}; raw values are masked by settings routes. */
    api_key: string;
  };
  signal_filters: SignalFilterConfig;
  memory: {
    // The standalone @nexus/memory-daemon (markdown-canonical vault + index).
    daemon_url: string;
  };
  obsidian: {
    vault_path: string;
    sync_interval_seconds: number;
  };
  jira: {
    /** When false (default) the poll loop stays dormant. */
    enabled: boolean;
    /** Atlassian account email used for basic auth (paired with JIRA_TOKEN). */
    user: string;
    /** Jira Cloud host, e.g. "safety-services.atlassian.net". */
    instance: string;
    /** Project key to sync, e.g. "SUP". */
    project: string;
    /** Poll cadence in minutes while Nexus is running. */
    poll_minutes: number;
    /** User-maintained chunks stripped from every ticket body during cleaning.
     *  Whitespace/case-tolerant literal match; three asterisks match any text. */
    content_rules: string[];
  };
  github: {
    /** When false the GitHub issue sync no-ops. Defaults to true so existing
     *  behaviour is preserved. The token is read from GITHUB_TOKEN only. */
    enabled: boolean;
  };
  monday: {
    /** When false the poll loop stays dormant and no tools are registered. */
    enabled: boolean;
    /** Pinned Monday API version. Monday dates its API; an unpinned client
     *  shifts under you. */
    api_version: string;
    /** Linked-item refresh cadence in minutes while Nexus is running. */
    poll_minutes: number;
  };
}

/** Which roll-up bucket each Kanban column contributes to. */
export const MONDAY_ROLLUP_BUCKETS: Record<TaskStatus, 'open' | 'inProgress' | 'inReview' | 'done'> = {
  triage: 'open',
  todo: 'open',
  in_progress: 'inProgress',
  review: 'inReview',
  deploy: 'done',
};

/** A mirrored Monday item. Disposable — Monday stays canonical. */
export interface MondayItem {
  item_id: string;
  board_id: string;
  board_name: string;
  group_id: string | null;
  group_title: string | null;
  name: string;
  /** 'missing' is Nexus-local: the item vanished from Monday but a link survives. */
  state: 'active' | 'archived' | 'deleted' | 'missing';
  status_label: string | null;
  status_color: string | null;
  /** JSON array of owner display names. */
  owners_json: string;
  url: string | null;
  /** Raw column values, keyed by column id. Context injection and the read
   *  tools need fields this schema does not model. */
  column_values_json: string;
  /** JSON array of the item's most recent updates — Monday's per-item
   *  comment thread, fetched via the `updates` connection in client.ts's
   *  ITEM_FIELDS (NOT a column value, despite the similarly-named
   *  `column_values_json`). Each entry is `{ text: string; created_at:
   *  string | null }`; order is whatever Monday/mapItem produced —
   *  session-deps.ts's recentUpdates() sorts newest-first when reading it.
   *  Optional so hand-built fixtures predating this field, and rows written
   *  before the migration backfills it, don't need to supply it; the DB
   *  column itself is NOT NULL DEFAULT '[]'. */
  updates_json?: string;
  monday_updated_at: string | null;
  synced_at: string;
}

/** A mirrored item enriched with its Nexus roll-up, as returned by the API. */
export interface MondayItemWithLinks extends MondayItem {
  rollup: { total: number; open: number; inProgress: number; inReview: number; done: number };
  rollup_text: string;
  task_ids: string[];
}

/** A task→item link. NOT disposable: user intent, survives a mirror wipe. */
export interface TaskMondayLink {
  task_id: string;
  item_id: string;
  project_id: string;
  created_at: string;
}

/** Per-project Monday scope and opt-ins, stored in projects.config_json. */
export interface MondayProjectConfig {
  board_id: string;
  /** Optional narrowing to a single group on the board. */
  group_id?: string | null;
  rollup: {
    enabled: boolean;
    column_id: string | null;
    /** Resolved when the column is chosen, not inferred per write: Monday
     *  column ids are user-renamable, so the id is not a reliable type hint. */
    column_type: 'text' | 'numeric';
  };
  updates: { enabled: boolean; min_interval_minutes: number };
}

export interface ProjectConfig {
  column_defaults: Record<TaskStatus, string | null>;
  monday?: MondayProjectConfig;
}

export const KANBAN_COLUMNS: TaskStatus[] = ['triage', 'todo', 'in_progress', 'review', 'deploy'];

export const KANBAN_COLUMN_LABELS: Record<TaskStatus, string> = {
  triage: 'Triage',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  deploy: 'Deploy',
};
export * from './agent-run.js';
