/**
 * Shared types for the Nexus backend and frontend.
 *
 * The chat runtime is now the pi-coding-agent SDK; persona/provider/PTY
 * surfaces are gone. Only the types the new code paths still need are
 * exported.
 */

export type TaskStatus = 'triage' | 'todo' | 'in_progress' | 'review' | 'deploy';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Project {
  id: string;
  slug: string;
  name: string;
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
}

export interface ProjectConfig {
  column_defaults: Record<TaskStatus, string | null>;
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
