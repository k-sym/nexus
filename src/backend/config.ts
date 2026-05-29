/**
 * Config & filesystem bootstrap.
 *
 * Reads/writes ~/.nexus/config.yaml (creating defaults on first run),
 * ensures the ~/.nexus directory tree exists, seeds the four default
 * persona YAML files, and provides ${ENV_VAR} interpolation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { NexusConfig } from '@nexus/shared';

const NEXUS_DIR = path.join(os.homedir(), '.nexus');
const CONFIG_PATH = path.join(NEXUS_DIR, 'config.yaml');

const DEFAULT_CONFIG: NexusConfig = {
  server: { port: 4173 },
  models: {
    openrouter: { api_key: '${OPENROUTING_API_KEY}' },
    ollama: { base_url: 'http://localhost:11434' },
  },
  mem0: {
    api_url: 'http://localhost:8051',
    auto_inject: {
      enabled: true,
      max_memories: 5,
      token_budget: 1000,
    },
  },
  obsidian: {
    vault_path: path.join(os.homedir(), '.nexus', 'obsidian'),
    sync_interval_seconds: 30,
  },
  scheduler: {
    enabled: true,
    check_interval_seconds: 60,
  },
  claude_code: {
    command: 'claude',
    args: ['--no-interactive'],
  },
  codex: {
    command: 'codex',
    args: [],
  },
  chat: {
    model: 'openrouter/anthropic/claude-sonnet-4',
    hot_storage_hours: 48,
    archive_path: 'Projects/{project_slug}/Chats',
  },
};

export function ensureNexusDir(): void {
  const dirs = [
    NEXUS_DIR,
    path.join(NEXUS_DIR, 'personas'),
    path.join(NEXUS_DIR, 'workspaces'),
    path.join(NEXUS_DIR, 'obsidian'),
    path.join(NEXUS_DIR, 'obsidian', 'Projects'),
    path.join(NEXUS_DIR, 'obsidian', 'Memories'),
    path.join(NEXUS_DIR, 'obsidian', 'Templates'),
    path.join(NEXUS_DIR, 'logs'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function seedDefaultPersonas(): void {
  const personasDir = path.join(NEXUS_DIR, 'personas');
  const defaults = [
    {
      slug: 'developer',
      yaml: {
        name: 'Developer',
        slug: 'developer',
        provider: 'claude_code',
        model: 'claude-sonnet-4',
        system_prompt: 'You are an expert software developer. Write clean, well-tested code. Follow the project\'s existing conventions.',
        tools: ['read_file', 'write_file', 'run_command', 'list_files'],
        workspace: '~/Projects/{project}',
        startup_scripts: ['git status'],
        token_budget: 4000,
      },
    },
    {
      slug: 'reviewer',
      yaml: {
        name: 'Reviewer',
        slug: 'reviewer',
        provider: 'codex',
        model: 'codex-default',
        system_prompt: 'You are a senior code reviewer. Focus on correctness, security, maintainability, and adherence to project conventions.',
        tools: ['read_file', 'list_files', 'run_command'],
        workspace: '~/Projects/{project}',
        startup_scripts: ['git fetch origin'],
        token_budget: 3000,
      },
    },
    {
      slug: 'generalist',
      yaml: {
        name: 'Generalist',
        slug: 'generalist',
        provider: 'openrouter',
        model: 'openrouter/anthropic/claude-sonnet-4',
        system_prompt: 'You are a versatile assistant capable of handling diverse tasks including writing, analysis, planning, marketing, and general problem solving.',
        tools: ['read_file', 'write_file', 'run_command', 'list_files'],
        workspace: '~/Projects/{project}',
        startup_scripts: [],
        token_budget: 4000,
      },
    },
    {
      slug: 'cron-runner',
      yaml: {
        name: 'Cron Runner',
        slug: 'cron-runner',
        provider: 'ollama',
        model: 'qwen2.5:14b',
        system_prompt: 'You are a task automation assistant. Execute scheduled tasks efficiently and report results concisely.',
        tools: ['read_file', 'write_file', 'run_command'],
        workspace: '~/Projects/{project}',
        startup_scripts: [],
        token_budget: 2000,
      },
    },
  ];

  const indexPath = path.join(personasDir, '.seeded');
  if (fs.existsSync(indexPath)) return;

  for (const { slug, yaml: persona } of defaults) {
    const filePath = path.join(personasDir, `${slug}.yaml`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, yaml.dump(persona, { lineWidth: 120, noRefs: true }), 'utf-8');
    }
  }
  fs.writeFileSync(indexPath, new Date().toISOString(), 'utf-8');
}

export function loadConfig(): NexusConfig {
  ensureNexusDir();
  seedDefaultPersonas();

  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = yaml.load(raw) as NexusConfig;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function saveConfig(config: NexusConfig): void {
  ensureNexusDir();
  const yamlStr = yaml.dump(config, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(CONFIG_PATH, yamlStr, 'utf-8');
}

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

export function getNexusDir(): string {
  return NEXUS_DIR;
}

export function getDbPath(): string {
  return path.join(NEXUS_DIR, 'nexus.db');
}
