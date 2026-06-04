export type TaskStatus = 'triage' | 'todo' | 'in_progress' | 'review' | 'deploy';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  repo_path: string;
  config_json: string;
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
  assigned_agent: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Persona {
  id: string;
  name: string;
  slug: string;
  config_yaml: string;
  created_at: string;
}

export interface Schedule {
  id: string;
  project_id: string;
  name: string;
  cron_expr: string;
  task_template: string;
  task_description: string;
  agent_id: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
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

export interface ChatThread {
  id: string;
  project_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  /** Latest Claude Code CLI session id for this thread, captured per turn so the
   *  conversation can be resumed from a terminal with `claude --resume <id>`. */
  agent_session_id?: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments_json: string;
  /** 'text' (default), 'question' (assistant asks), or 'answer' (user's selection). */
  message_type: 'text' | 'question' | 'answer';
  /** For 'question': a serialized Ask. For 'answer': a serialized AnswerSet. Else null. */
  structured_json: string | null;
  created_at: string;
}

export interface FileAttachment {
  filename: string;
  original_name: string;
  path: string;
  mime_type: string;
}

/**
 * One event in a streamed chat turn (NDJSON over the streaming endpoint).
 * `delta` is a best-effort live preview; the authoritative reply arrives in
 * `done.message`. `session` carries the captured Claude/Codex/OpenCode session id.
 */
export type ChatStreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'session'; session_id: string }
  | { kind: 'done'; message: ChatMessage }
  | { kind: 'error'; error: string };

/** One selectable option in a question. */
export interface QuestionOption {
  label: string;
  description: string;
}

/** A single question an agent asks the user. Normalized: multiple/custom always set. */
export interface Question {
  /** Short label, ≤30 chars. */
  header: string;
  /** The full question text. */
  question: string;
  options: QuestionOption[];
  /** Allow selecting more than one option. */
  multiple: boolean;
  /** Allow a free-text ("Type your own answer") response. */
  custom: boolean;
}

/** The payload an agent emits in a fenced ```ask``` block. */
export interface Ask {
  questions: Question[];
}

/** The user's answer to one question (index-aligned with Ask.questions). */
export interface Reply {
  /** Carried for display only — not a join key (headers may collide). */
  header: string;
  /** Selected option labels. */
  selected: string[];
  /** Free-text answer, when the user used "Type your own answer". */
  custom?: string;
}

/** The full set of replies stored on an 'answer' message. */
export interface AnswerSet {
  replies: Reply[];
}

/** A configured, testable provider instance (a harness endpoint the app can use). */
export type ProviderKind = 'claude_code' | 'codex' | 'opencode' | 'hermes' | 'openai_compat';
export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** openai_compat only — base URL incl. /v1 (OpenRouter, omlx, LM Studio, llama.cpp…). */
  base_url: string | null;
  /** openai_compat only — bearer token; supports ${ENV_VAR} interpolation. */
  api_key: string | null;
  /** optional default model for this provider. */
  default_model: string | null;
  /** curated list of model identifiers this provider offers (shown in the persona dropdown). */
  models: string[];
  /** optional free-form CLI launch flags — OpenCode only (e.g. "--agent build"). */
  args: string | null;
  created_at: string;
}

export interface PersonaConfig {
  name: string;
  slug: string;
  // Legacy provider enum — kept as a fallback when provider_id is unset.
  // 'local' = any OpenAI-compatible local server (omlx, LM Studio, llama.cpp…).
  // 'ollama' is kept as a legacy alias, treated identically to 'local'.
  provider: 'claude_code' | 'codex' | 'openrouter' | 'local' | 'ollama';
  /** Preferred: references a first-class Provider record by id. */
  provider_id?: string;
  model: string;
  system_prompt: string;
  /** Phosphor icon name from PERSONA_ICON_NAMES; identifies the persona at a glance. */
  icon?: string;
  /** Accent colour (hex, e.g. "#f59e0b") for the icon and thread-row tint. */
  color?: string;
  tools: string[];
  workspace: string;
  startup_scripts: string[];
  token_budget: number;
}

/** Curated Phosphor icon names offered for personas (name→component map lives in the frontend). */
export const PERSONA_ICON_NAMES = [
  'Wrench', 'Code', 'MagnifyingGlass', 'Compass', 'PaintBrush',
  'Brain', 'Lightning', 'Robot', 'Detective', 'Sparkle',
] as const;
export type PersonaIconName = typeof PERSONA_ICON_NAMES[number];

/** Default accent when a persona has no colour set. */
export const DEFAULT_PERSONA_COLOR = '#a1a1aa'; // zinc-400

export interface NexusConfig {
  server: { port: number };
  models: {
    openrouter: { api_key: string };
    // Local OpenAI-compatible server. base_url should include the /v1 suffix,
    // e.g. http://localhost:8000/v1 for omlx. embedding_model / rerank_model
    // are optional; empty means that capability is disabled (memory falls back
    // to lexical TF-IDF search).
    local: {
      base_url: string;
      api_key: string;
      embedding_model: string;
      rerank_model: string;
    };
  };
  memory: {
    // The standalone @nexus/memory-daemon (markdown-canonical vault + index).
    daemon_url: string;
    auto_inject: {
      enabled: boolean;
      max_memories: number;
      token_budget: number;
    };
  };
  obsidian: {
    vault_path: string;
    sync_interval_seconds: number;
  };
  scheduler: {
    enabled: boolean;
    check_interval_seconds: number;
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
  };
  claude_code: {
    command: string;
    args: string[];
    /** Inactivity timeout (seconds) for a Claude Code turn — the process is killed
     *  only after this long with NO streamed activity, not on wall-clock time, so
     *  long-but-active tasks aren't cut off. Defaults to 600 if unset. */
    idle_timeout_seconds?: number;
  };
  codex: {
    command: string;
    args: string[];
  };
  chat: {
    model: string;
    hot_storage_hours: number;
    archive_path: string;
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
