import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { identifier, instanceIdentifier } from './protocol.js';

export interface ClientConfig {
  url: string;
  instance_id: string;
  sender_id: string;
  backend_url: string;
  token: string;
  backend_token: string;
  state_dir: string;
}
const fields = ['url', 'instance_id', 'sender_id', 'backend_url', 'token', 'backend_token'] as const;
export function loopback(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}
export function validateConfig(config: ClientConfig): ClientConfig {
  instanceIdentifier(config.instance_id);
  identifier(config.sender_id, 'sender ID');
  let broker: URL, backend: URL;
  try { broker = new URL(config.url); backend = new URL(config.backend_url); }
  catch { throw new Error('Configure valid broker and backend URLs.'); }
  for (const url of [broker, backend]) {
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
      throw new Error('Endpoint URLs must have no credentials, path, query or fragment.');
    }
  }
  if (!['nats:', 'tls:'].includes(broker.protocol)) throw new Error('Broker URL must use nats:// or tls://.');
  if (!loopback(broker.hostname) && broker.protocol !== 'tls:') throw new Error('Remote brokers require tls:// and a token.');
  if (broker.protocol === 'tls:' && !config.token.trim()) throw new Error('TLS brokers require a token in bridge_client.token or NEXUS_AGENT_BRIDGE_TOKEN.');
  if (backend.protocol !== 'https:' && !(backend.protocol === 'http:' && loopback(backend.hostname))) {
    throw new Error('Backend URL requires HTTPS, or HTTP on loopback.');
  }
  return { ...config, url: broker.toString(), backend_url: backend.origin };
}
function readYaml(path: string, required: boolean): Record<string, unknown> {
  let raw: unknown;
  try { raw = load(readFileSync(path, 'utf8')) ?? {}; }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // YAML parser messages can quote secret values; never forward them.
    throw new Error('Could not read client configuration; check its path and YAML syntax.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Client configuration must be a mapping.');
  return raw as Record<string, unknown>;
}
function clientFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bridge_client must be a mapping.');
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(key => !fields.includes(key as typeof fields[number]))) {
    throw new Error('Client configuration accepts only url, instance_id, sender_id, backend_url, token and backend_token.');
  }
  for (const key of fields) if (values[key] !== undefined && typeof values[key] !== 'string') throw new Error(`Client ${key} must be text.`);
  return values as Record<string, string>;
}
function secret(value: string, env: NodeJS.ProcessEnv): string {
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!reference) return value;
  if (!env[reference[1]]) throw new Error(`Export ${reference[1]} or store a token value in bridge_client configuration.`);
  return env[reference[1]]!;
}
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const nexusHome = env.NEXUS_HOME ?? join(homedir(), '.nexus');
  const explicit = path ?? env.NEXUS_BRIDGE_CONFIG;
  let yaml: Record<string, string>;
  if (explicit) {
    const raw = readYaml(explicit, true);
    yaml = clientFields(raw.bridge_client ?? raw);
  } else {
    const shared = readYaml(join(nexusHome, 'config.yaml'), false);
    const standalone = readYaml(join(nexusHome, 'bridge-client.yaml'), false);
    yaml = { ...clientFields(shared.bridge_client ?? {}), ...clientFields(standalone) };
  }
  return validateConfig({
    url: env.NEXUS_BRIDGE_URL ?? yaml.url ?? 'nats://127.0.0.1:4222',
    instance_id: env.NEXUS_BRIDGE_INSTANCE ?? yaml.instance_id ?? '',
    sender_id: env.NEXUS_BRIDGE_SENDER ?? yaml.sender_id ?? '',
    backend_url: env.NEXUS_BRIDGE_BACKEND_URL ?? yaml.backend_url ?? 'http://127.0.0.1:4173',
    token: secret(env.NEXUS_AGENT_BRIDGE_TOKEN ?? yaml.token ?? '', env),
    backend_token: secret(env.NEXUS_BRIDGE_BACKEND_TOKEN ?? yaml.backend_token ?? '', env),
    state_dir: env.NEXUS_BRIDGE_STATE_DIR ?? join(nexusHome, 'bridge-client'),
  });
}
export function safeError(error: unknown, config?: ClientConfig): string {
  let text = error instanceof Error ? error.message : 'Bridge operation failed.';
  for (const secret of [config?.token, config?.backend_token]) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}
export function identity(config: ClientConfig) {
  return { senderId: config.sender_id, instanceId: config.instance_id, brokerUrl: config.url, backendUrl: config.backend_url, harness: 'nexus-bridge-client' };
}
