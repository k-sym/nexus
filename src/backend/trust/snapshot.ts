import { join, resolve } from 'node:path';
import type { NexusConfig } from '@nexus/shared';
import type { PiRuntime } from '../pi/runtime.js';
import { expandHome, getNexusDir, resolveEnvVars } from '../config.js';
import { resolveGitHubTokenStatus } from '../github/token.js';

export type SecretSource = 'environment' | 'config-env-reference' | 'config-literal' | 'pi-auth-file' | 'gh-cli' | 'absent' | 'unknown';
export interface TrustSecret { configured: boolean; source: SecretSource; location?: string; credentialType?: 'api_key' | 'oauth' }
export interface TrustSnapshot {
  services: Array<{ name: string; url: string; loopback: boolean }>;
  storage: Array<{ name: string; path: string; role: 'canonical' | 'rebuildable' | 'application' | 'credentials' | 'configuration' }>;
  secrets: Record<string, TrustSecret>;
  memory: { namespaces: string[]; autoInject: { enabled: boolean; maxMemories: number; tokenBudget: number }; archive: { mode: 'manual'; destination: string; removesHotThreadAfterSuccess: true } };
  outbound: Array<{ name: string; destination: string; sends: string[]; enabled: boolean }>;
  telemetry: { applicationTelemetry: false; statement: string };
}

export interface TrustSnapshotDependencies {
  githubStatus?: typeof resolveGitHubTokenStatus;
  nexusDir?: string;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function configSecret(value: string, fallbackEnvironment: string[] = []): TrustSecret {
  const envNames = [...value.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]);
  if (resolveEnvVars(value).length > 0) {
    return {
      configured: true,
      source: envNames.length > 0 ? 'config-env-reference' : 'config-literal',
    };
  }
  if (fallbackEnvironment.some((name) => Boolean(process.env[name]))) {
    return { configured: true, source: 'environment' };
  }
  return { configured: false, source: envNames.length > 0 ? 'config-env-reference' : 'absent' };
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    const withoutQuery = value.split(/[?#]/, 1)[0];
    const at = withoutQuery.lastIndexOf('@');
    return at >= 0 ? withoutQuery.slice(at + 1) : withoutQuery;
  }
}

function effectivePath(value: string): string {
  return resolve(expandHome(value));
}

function boundaryName(subject: string, url: string): string {
  return `${isLoopback(url) ? 'Local' : 'Remote'} ${subject} endpoint`;
}

export async function buildTrustSnapshot(
  config: NexusConfig,
  pi: Pick<PiRuntime, 'auth' | 'paths'>,
  dependencies: TrustSnapshotDependencies = {},
): Promise<TrustSnapshot> {
  const raw = config as NexusConfig & { memory: NexusConfig['memory'] & {
    vault_path?: string;
    db_path?: string;
    models?: { gen_url?: string; embed_url?: string; rerank_url?: string };
  } };
  const vault = effectivePath(raw.memory.vault_path ?? config.obsidian.vault_path);
  const indexPath = effectivePath(raw.memory.db_path ?? join(vault, '.index', 'nexus-memory.db'));
  const nexusDir = dependencies.nexusDir ?? getNexusDir();
  const daemonEndpoint = process.env.MEMORY_DAEMON_URL || config.memory.daemon_url || 'http://127.0.0.1:4100';
  const generationUrl = raw.memory.models?.gen_url ?? 'http://127.0.0.1:4001/v1';
  const embeddingUrl = raw.memory.models?.embed_url ?? 'http://127.0.0.1:4002/v1';
  const rerankUrl = raw.memory.models?.rerank_url ?? 'http://127.0.0.1:4003/v1';
  const githubStatus = await (dependencies.githubStatus ?? resolveGitHubTokenStatus)()
    .catch(() => ({ configured: false as const, source: 'unknown' as const }));

  const secrets: Record<string, TrustSecret> = {
    openrouter: configSecret(config.models.openrouter.api_key ?? '', ['OPENROUTER_API_KEY', 'OPENROUTING_API_KEY']),
    localModel: configSecret(config.models.local.api_key ?? ''),
    assistant: configSecret(config.assistant.api_key ?? '', ['ASSISTANT_API_KEY']),
    jira: process.env.JIRA_TOKEN
      ? { configured: true, source: 'environment' }
      : { configured: false, source: 'absent' },
    github: githubStatus,
  };
  const piProviderIds: string[] = [];
  try {
    for (const credential of await pi.auth.listCredentials()) {
      const provider = credential.providerId;
      try {
        piProviderIds.push(provider);
        secrets[`pi:${provider}`] = {
          configured: true,
          source: 'pi-auth-file',
          location: pi.paths.authFile,
          credentialType: credential.type === 'oauth' ? 'oauth' as const : 'api_key' as const,
        };
      } catch {
        secrets[`pi:${provider}`] = { configured: false, source: 'unknown', location: pi.paths.authFile };
      }
    }
  } catch {
    secrets['pi-auth'] = { configured: false, source: 'unknown', location: pi.paths.authFile };
  }

  return {
    services: [
      { name: 'Nexus backend', url: `http://127.0.0.1:${config.server.port}`, loopback: true },
      { name: 'Frontend development server', url: 'http://127.0.0.1:5173', loopback: true },
      { name: 'Memory daemon', url: safeUrl(daemonEndpoint), loopback: isLoopback(daemonEndpoint) },
      { name: boundaryName('memory generation', generationUrl), url: safeUrl(generationUrl), loopback: isLoopback(generationUrl) },
      { name: boundaryName('memory embedding', embeddingUrl), url: safeUrl(embeddingUrl), loopback: isLoopback(embeddingUrl) },
      { name: boundaryName('memory reranking', rerankUrl), url: safeUrl(rerankUrl), loopback: isLoopback(rerankUrl) },
    ],
    storage: [
      { name: 'Nexus database', path: join(nexusDir, 'nexus.db'), role: 'application' },
      { name: 'Canonical memory vault', path: vault, role: 'canonical' },
      { name: 'Memory index', path: indexPath, role: 'rebuildable' },
      { name: 'Nexus configuration', path: join(nexusDir, 'config.yaml'), role: 'configuration' },
      { name: 'Pi credentials', path: pi.paths.authFile, role: 'credentials' },
    ],
    secrets,
    memory: {
      namespaces: ['nexus', 'global'],
      autoInject: {
        enabled: config.memory.auto_inject.enabled,
        maxMemories: config.memory.auto_inject.max_memories,
        tokenBudget: config.memory.auto_inject.token_budget,
      },
      archive: { mode: 'manual', destination: 'nexus', removesHotThreadAfterSuccess: true },
    },
    outbound: [
      { name: 'OpenRouter', destination: 'https://openrouter.ai', sends: ['prompts', 'conversation content', 'model responses'], enabled: secrets.openrouter.configured },
      {
        name: boundaryName('chat model', config.models.local.base_url),
        destination: safeUrl(config.models.local.base_url),
        sends: ['prompts', 'conversation content', 'tool results', 'recalled memory'],
        enabled: Boolean(config.models.local.base_url),
      },
      {
        name: boundaryName('memory generation', generationUrl),
        destination: safeUrl(generationUrl),
        sends: ['memory content', 'retrieval queries'],
        enabled: Boolean(generationUrl),
      },
      {
        name: boundaryName('memory embedding', embeddingUrl),
        destination: safeUrl(embeddingUrl),
        sends: ['memory content', 'retrieval queries'],
        enabled: Boolean(embeddingUrl),
      },
      {
        name: boundaryName('memory reranking', rerankUrl),
        destination: safeUrl(rerankUrl),
        sends: ['retrieval queries', 'candidate memory content'],
        enabled: Boolean(rerankUrl),
      },
      ...piProviderIds.map((provider) => ({
        name: `Pi provider: ${provider}`,
        destination: 'Provider-managed API endpoint',
        sends: ['prompts', 'conversation content', 'tool results', 'recalled memory'],
        enabled: true,
      })),
      { name: 'Assistant', destination: safeUrl(config.assistant.url), sends: ['prompts', 'conversation content'], enabled: Boolean(config.assistant.url) },
      { name: 'Jira', destination: safeUrl(config.jira.instance), sends: ['account identity', 'ticket queries'], enabled: config.jira.enabled },
      { name: 'GitHub', destination: 'https://api.github.com', sends: ['repository identity', 'issue queries'], enabled: config.github.enabled },
    ],
    telemetry: {
      applicationTelemetry: false,
      statement: 'Nexus has no application analytics or telemetry integration. Configured providers receive requests needed to provide their service.',
    },
  };
}
