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
    openrouter: { api_key: '${OPENROUTER_API_KEY}' },
    local: {
      base_url: 'http://127.0.0.1:4001/v1',
      api_key: '${OMLX_API_KEY}',
      embedding_model: '',
      rerank_model: '',
    },
  },
  memory: {
    daemon_url: 'http://127.0.0.1:4100',
    auto_inject: {
      enabled: true,
      max_memories: 5,
      token_budget: 1000,
    },
  },
  obsidian: {
    // Visible location so the vault shows up in Obsidian's "Open folder as
    // vault" picker. A dot-prefixed path like ~/.nexus/obsidian is hidden and
    // unselectable there. App state (config.yaml, db, logs) stays in ~/.nexus.
    vault_path: path.join(os.homedir(), 'Obsidian', 'Nexus'),
    sync_interval_seconds: 30,
  },
  scheduler: {
    enabled: true,
    check_interval_seconds: 60,
  },
  jira: {
    enabled: false,
    user: '',
    instance: '',
    project: 'SUP',
    poll_minutes: 15,
  },
  claude_code: {
    command: 'claude',
    args: [],
    idle_timeout_seconds: 600,
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

/** Expand a leading ~ to the user's home dir; paths are stored absolute. */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function ensureNexusDir(): void {
  const dirs = [
    NEXUS_DIR,
    path.join(NEXUS_DIR, 'personas'),
    path.join(NEXUS_DIR, 'workspaces'),
    path.join(NEXUS_DIR, 'logs'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Create the Obsidian vault tree at the configured (possibly relocated) path,
 * rather than assuming it lives under ~/.nexus. Called once the config is
 * resolved so the override in config.yaml is honored.
 */
export function ensureVaultDir(vaultPath: string): void {
  const root = expandHome(vaultPath);
  for (const sub of ['', 'Projects', 'Memories', 'Templates']) {
    const dir = sub ? path.join(root, sub) : root;
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
        provider: 'local',
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
    ensureVaultDir(DEFAULT_CONFIG.obsidian.vault_path);
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = (yaml.load(raw) as Partial<NexusConfig>) || {};
  // Deep-merge over defaults so configs written by older versions (missing
  // nested keys like models.local) still load with sane fallbacks rather than
  // producing `undefined` and crashing at access time.
  const config = deepMerge(DEFAULT_CONFIG, parsed) as NexusConfig;
  // Existing installs keep whatever vault_path their config.yaml already
  // persisted (e.g. the legacy ~/.nexus/obsidian); only fresh installs get the
  // new visible default above.
  ensureVaultDir(config.obsidian.vault_path);
  return config;
}

/** Recursively merge `source` over `base`. Arrays and primitives are replaced. */
function deepMerge<T>(base: T, source: any): T {
  if (source === null || source === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (source ?? base) as T;
  }
  const out: any = { ...base };
  for (const key of Object.keys(source)) {
    const baseVal = (base as any)[key];
    const srcVal = source[key];
    if (baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) && srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      out[key] = deepMerge(baseVal, srcVal);
    } else if (srcVal !== undefined) {
      out[key] = srcVal;
    }
  }
  return out as T;
}

export function saveConfig(config: NexusConfig): void {
  ensureNexusDir();
  const yamlStr = yaml.dump(config, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(CONFIG_PATH, yamlStr, 'utf-8');
}

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

/**
 * Resolve the OpenRouter API key, tolerating both the documented
 * OPENROUTER_API_KEY and the legacy OPENROUTING_API_KEY spelling, plus any
 * literal/interpolated value stored in config.yaml.
 */
export function resolveOpenRouterKey(config: NexusConfig): string {
  const fromConfig = resolveEnvVars(config.models.openrouter.api_key || '');
  if (fromConfig) return fromConfig;
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTING_API_KEY || '';
}

export function getNexusDir(): string {
  return NEXUS_DIR;
}

export function getDbPath(): string {
  return path.join(NEXUS_DIR, 'nexus.db');
}
