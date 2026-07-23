/**
 * Config & filesystem bootstrap.
 *
 * Reads/writes ~/.nexus/config.yaml (creating defaults on first run),
 * ensures the ~/.nexus directory tree exists, seeds the four default
 * persona YAML files, and provides ${ENV_VAR} interpolation.
 *
 * Set NEXUS_HOME to relocate that whole tree — tests point it at a scratch
 * directory so they never touch the developer's real config.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// Namespace import, not default: js-yaml 5 (#226) is ESM-only with named exports
// and no default, so `import yaml from 'js-yaml'` throws at load time.
import * as yaml from 'js-yaml';
import { NexusConfig } from '@nexus/shared';

/**
 * Root of the Nexus state tree — ~/.nexus unless NEXUS_HOME overrides it (the
 * memory daemon honours the same variable). Resolved on every call rather than
 * captured at module load so tests can point the whole tree at a scratch dir
 * after importing this module, instead of writing to the developer's real
 * ~/.nexus/config.yaml.
 */
function nexusDir(): string {
  const override = process.env.NEXUS_HOME?.trim();
  // Resolved to absolute: every consumer joins onto this, and a relative
  // NEXUS_HOME would otherwise follow the process's cwd around.
  return override ? path.resolve(expandHome(override)) : path.join(os.homedir(), '.nexus');
}

function configPath(): string {
  return path.join(nexusDir(), 'config.yaml');
}

/**
 * Freshly built each call: the defaults depend on NEXUS_HOME, and loadConfig()
 * hands this object straight back on first run, so a shared instance would be
 * mutable global state.
 */
function defaultConfig(): NexusConfig {
  return {
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
        display_name: 'Custom Model',
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
    },
    obsidian: {
      vault_path: defaultVaultPath(),
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
    browser: {
      // Off by default for the same reason as docker: an agent-driven browser
      // reaches out to the network and executes whatever it is served.
      enabled: false,
      // Loopback is always permitted; this widens it and nothing else.
      allow_hosts: [],
    },
    docker: {
      // Off by default: the tool starts containers that bind host ports, so it
      // is opt-in even on a machine where Docker is running. Turning it on
      // still doesn't make it silent — `services` defaults to `confirm` in the
      // tool policy (see pi/tool-policy.ts).
      enabled: false,
    },
    monday: {
      enabled: false,
      // '2024-10' was deprecated 2026-02-15; pinned to '2026-07', the current
      // stable version as of 2026-07-22 (confirmed against
      // developer.monday.com/api-reference/docs/api-versioning).
      api_version: '2026-07',
      poll_minutes: 10,
    },
  };
}

/**
 * Where a fresh install puts the Obsidian vault. Visible location so the vault
 * shows up in Obsidian's "Open folder as vault" picker — a dot-prefixed path
 * like ~/.nexus/obsidian is hidden and unselectable there. App state
 * (config.yaml, db, logs) stays in ~/.nexus.
 *
 * Under NEXUS_HOME the vault moves inside that root instead, so loading a
 * config from a scratch dir never creates directories in the real home.
 */
function defaultVaultPath(): string {
  return process.env.NEXUS_HOME?.trim()
    ? path.join(nexusDir(), 'Obsidian')
    : path.join(os.homedir(), 'Obsidian', 'Nexus');
}

/** Expand a leading ~ to the user's home dir; paths are stored absolute. */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function ensureNexusDir(): void {
  const root = nexusDir();
  const dirs = [
    root,
    path.join(root, 'workspaces'),
    path.join(root, 'logs'),
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

/**
 * Parse the raw config.yaml text into the overrides layered over the defaults.
 *
 * An empty file means "no overrides" — that is what the old `|| {}` fallback
 * expressed, but js-yaml 5 (#226) throws `expected a document, but the input is
 * empty` where js-yaml 4 returned `undefined`, so the empty case has to be
 * caught before the parse. Otherwise a zero-byte config.yaml — left by a
 * crashed editor, a full disk, or a user emptying the file — takes the whole
 * backend down at startup instead of falling back to defaults.
 *
 * Malformed YAML still throws: a corrupt config must fail loudly rather than
 * silently resolve to defaults that the next save would persist over the
 * user's real settings.
 */
export function parseConfigYaml(raw: string): Partial<NexusConfig> {
  if (raw.trim() === '') return {};
  return (yaml.load(raw) as Partial<NexusConfig>) || {};
}

export function loadConfig(): NexusConfig {
  ensureNexusDir();

  const defaults = defaultConfig();
  if (!fs.existsSync(configPath())) {
    saveConfig(defaults);
    ensureVaultDir(defaults.obsidian.vault_path);
    return defaults;
  }

  const raw = fs.readFileSync(configPath(), 'utf-8');
  const parsed = parseConfigYaml(raw);
  // Deep-merge over defaults so configs written by older versions (missing
  // nested keys like models.local) still load with sane fallbacks rather than
  // producing `undefined` and crashing at access time.
  const config = deepMerge(defaults, parsed) as NexusConfig;
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
  // Write-then-rename: the backend, the memory daemon and the Tauri shell all
  // read config.yaml concurrently, and a plain writeFileSync leaves a window
  // where a reader sees a truncated file. rename(2) within the same directory
  // is atomic, so readers see either the old or the new config, never a
  // half-written one.
  const target = configPath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, yamlStr, 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // A failed write (full disk, permissions) would otherwise strand the temp
    // file next to the config it never replaced.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
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
  return nexusDir();
}

export function getDbPath(): string {
  return path.join(nexusDir(), 'nexus.db');
}
