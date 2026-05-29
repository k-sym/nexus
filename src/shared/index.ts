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

export interface ChatThread {
  id: string;
  project_id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments_json: string;
  created_at: string;
}

export interface FileAttachment {
  filename: string;
  original_name: string;
  path: string;
  mime_type: string;
}

export interface PersonaConfig {
  name: string;
  slug: string;
  provider: 'claude_code' | 'codex' | 'openrouter' | 'ollama';
  model: string;
  system_prompt: string;
  tools: string[];
  workspace: string;
  startup_scripts: string[];
  token_budget: number;
}

export interface NexusConfig {
  server: { port: number };
  models: {
    openrouter: { api_key: string };
    ollama: { base_url: string };
  };
  mem0: {
    api_url: string;
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
  claude_code: {
    command: string;
    args: string[];
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
