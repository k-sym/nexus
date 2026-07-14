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
  // url: '' ⇒ full-stack (spawn a local backend). token: env-expanded, '' ⇒
  // dev-open (no auth) — same convention as gateway.token below.
  server: { port: 4173, url: '', token: '${NEXUS_BACKEND_TOKEN}' },
  gateway: {
    enabled: true,
    port: 8899,
    token: '${NEXUS_GATEWAY_TOKEN}',
    recent_minutes: 720,
    glasses_dist: '',
    stt: {
      provider: 'deepgram',
      api_key: '${DEEPGRAM_API_KEY}',
      language: 'en',
    },
  },
  models: {
    openrouter: { api_key: '${OPENROUTER_API_KEY}' },
    local: {
      base_url: 'http://127.0.0.1:4001/v1',
      api_key: '${OMLX_API_KEY}',
      display_name: 'Local Model',
      chat_model: '',
      supports_images: false,
      embedding_model: '',
      rerank_model: '',
    },
  },
  assistant: {
    url: '',
    api_key: '${ASSISTANT_API_KEY}',
  },
  signal_filters: {
    enabled: true,
    min_input_bytes: 4096,
    max_output_bytes: 12000,
    filters: {
      ansi: true,
      progress: true,
      repeated_lines: true,
      package_manager: true,
      test_output: true,
      stack_trace: true,
      diff_context: true,
    },
    projects: {},
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
  jira: {
    enabled: false,
    user: '',
    instance: '',
    project: 'SUP',
    poll_minutes: 15,
    content_rules: [],
  },
  github: {
    // Default true so the existing sync behaviour is preserved for configs
    // written before this block existed (deepMerge backfills it on load).
    enabled: true,
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

export function loadConfig(): NexusConfig {
  ensureNexusDir();

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

export function resolveAssistantKey(config: NexusConfig): string {
  const fromConfig = resolveEnvVars(config.assistant.api_key || '');
  if (fromConfig) return fromConfig;
  return process.env.ASSISTANT_API_KEY || '';
}

export function getNexusDir(): string {
  return NEXUS_DIR;
}

export function getDbPath(): string {
  return path.join(NEXUS_DIR, 'nexus.db');
}
