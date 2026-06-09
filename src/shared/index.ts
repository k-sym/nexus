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
  /** Set by the orchestrator's "In Progress" model picker; tasks without
   *  a model_key sit idle until the picker runs. */
  model_key: string | null;
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

/** A chat thread — one conversation per row, linked to a project. */
export interface ChatThread {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

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
