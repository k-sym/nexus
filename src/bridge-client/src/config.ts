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
const fields = ['url', 'instance_id', 'sender_id', 'backend_url'] as const;
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
  if (broker.protocol === 'tls:' && !config.token.trim()) throw new Error('TLS brokers require NEXUS_AGENT_BRIDGE_TOKEN.');
  if (backend.protocol !== 'https:' && !(backend.protocol === 'http:' && loopback(backend.hostname))) {
    throw new Error('Backend URL requires HTTPS, or HTTP on loopback.');
  }
  return { ...config, url: broker.toString(), backend_url: backend.origin };
}
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const configPath = path ?? env.NEXUS_BRIDGE_CONFIG ?? join(homedir(), '.nexus', 'bridge-client.yaml');
  let raw: unknown = {};
  try { raw = load(readFileSync(configPath, 'utf8')) ?? {}; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path || env.NEXUS_BRIDGE_CONFIG) {
      throw new Error('Could not read client configuration; check its path and YAML syntax.');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Client configuration must be a mapping.');
  const yaml = raw as Record<string, unknown>;
  if (Object.keys(yaml).some(key => !fields.includes(key as typeof fields[number]))) {
    throw new Error('Client YAML accepts only url, instance_id, sender_id and backend_url. Credentials must be environment variables.');
  }
  for (const key of fields) if (yaml[key] !== undefined && typeof yaml[key] !== 'string') throw new Error(`Client ${key} must be text.`);
  return validateConfig({
    url: env.NEXUS_BRIDGE_URL ?? yaml.url as string ?? 'nats://127.0.0.1:4222',
    instance_id: env.NEXUS_BRIDGE_INSTANCE ?? yaml.instance_id as string ?? '',
    sender_id: env.NEXUS_BRIDGE_SENDER ?? yaml.sender_id as string ?? '',
    backend_url: env.NEXUS_BRIDGE_BACKEND_URL ?? yaml.backend_url as string ?? 'http://127.0.0.1:4173',
    token: env.NEXUS_AGENT_BRIDGE_TOKEN ?? '',
    backend_token: env.NEXUS_BRIDGE_BACKEND_TOKEN ?? '',
    state_dir: env.NEXUS_BRIDGE_STATE_DIR ?? join(homedir(), '.nexus', 'bridge-client'),
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
