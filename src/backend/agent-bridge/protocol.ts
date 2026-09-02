import type { AgentBridgeConfig } from '@nexus/shared';

export const AGENT_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const AGENT_BRIDGE_STREAM = 'NEXUS_AGENT_BRIDGE_V1';
export const AGENT_BRIDGE_SUBJECT_PREFIX = 'nexus.bridge.v1.inbox';

export interface AgentBridgeEnvelopeV1 {
  version: typeof AGENT_BRIDGE_PROTOCOL_VERSION;
  kind: 'message';
  id: string;
  sentAt: string;
  sender: {
    id: string;
    displayName?: string;
    harness?: string;
  };
  target: {
    instanceId: string;
    projectId: string;
    threadId: string;
  };
  content: string;
  correlationId?: string;
  replyTo?: string;
  hopCount?: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function bridgeSubject(instanceId: string): string {
  return `${AGENT_BRIDGE_SUBJECT_PREFIX}.${instanceId}`;
}

export function validateInstanceId(value: string): boolean {
  // NATS subject tokens cannot contain dots, wildcards, or whitespace.
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

export function isLoopbackNatsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function validateAgentBridgeConfig(config: AgentBridgeConfig): string | null {
  if (!validateInstanceId(config.instance_id)) {
    return 'Agent Bridge instance id must use only letters, numbers, underscores, or hyphens (maximum 64 characters).';
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return 'Agent Bridge URL must be a valid NATS URL.';
  }
  if (!['nats:', 'tls:'].includes(url.protocol)) {
    return 'Agent Bridge URL must use nats:// or tls://.';
  }
  if (!isLoopbackNatsUrl(config.url) && url.protocol !== 'tls:') {
    return 'Remote Agent Bridge URLs must use tls://.';
  }
  if (!isLoopbackNatsUrl(config.url) && config.token.trim() === '') {
    return 'Remote Agent Bridge URLs require an authentication token.';
  }
  if (!Number.isInteger(config.max_message_bytes) || config.max_message_bytes < 1 || config.max_message_bytes > 1_048_576) {
    return 'Agent Bridge message size limit must be between 1 and 1048576 bytes.';
  }
  if (!Number.isInteger(config.max_messages_per_minute) || config.max_messages_per_minute < 1 || config.max_messages_per_minute > 10_000) {
    return 'Agent Bridge rate limit must be between 1 and 10000 messages per minute.';
  }
  if (!Number.isInteger(config.max_hops) || config.max_hops < 0 || config.max_hops > 32) {
    return 'Agent Bridge hop limit must be between 0 and 32.';
  }
  return null;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function requiredIdentifier(value: unknown, field: string): string {
  const parsed = optionalIdentifier(value, field);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

export function parseAgentBridgeEnvelope(
  value: unknown,
  maxMessageBytes: number,
  nowMs = Date.now(),
): AgentBridgeEnvelopeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Envelope must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== AGENT_BRIDGE_PROTOCOL_VERSION) throw new Error('Unsupported Agent Bridge protocol version');
  if (raw.kind !== 'message') throw new Error('Unsupported Agent Bridge envelope kind');
  if (!raw.sender || typeof raw.sender !== 'object' || Array.isArray(raw.sender)) throw new Error('sender is required');
  if (!raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)) throw new Error('target is required');
  const sender = raw.sender as Record<string, unknown>;
  const target = raw.target as Record<string, unknown>;
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (!content) throw new Error('content is required');
  if (new TextEncoder().encode(content).byteLength > maxMessageBytes) throw new Error('content exceeds the configured size limit');
  if (typeof raw.sentAt !== 'string' || !Number.isFinite(Date.parse(raw.sentAt))) throw new Error('sentAt must be an ISO timestamp');
  if (Date.parse(raw.sentAt) > nowMs + FUTURE_SKEW_MS) throw new Error('sentAt is too far in the future');
  const hopCount = raw.hopCount === undefined ? 0 : raw.hopCount;
  if (!Number.isInteger(hopCount) || (hopCount as number) < 0) throw new Error('hopCount must be a non-negative integer');
  const displayName = sender.displayName;
  const harness = sender.harness;
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 128)) throw new Error('sender.displayName is invalid');
  if (harness !== undefined && (typeof harness !== 'string' || harness.length > 64)) throw new Error('sender.harness is invalid');

  return {
    version: AGENT_BRIDGE_PROTOCOL_VERSION,
    kind: 'message',
    id: requiredIdentifier(raw.id, 'id'),
    sentAt: raw.sentAt,
    sender: {
      id: requiredIdentifier(sender.id, 'sender.id'),
      ...(typeof displayName === 'string' ? { displayName } : {}),
      ...(typeof harness === 'string' ? { harness } : {}),
    },
    target: {
      instanceId: requiredIdentifier(target.instanceId, 'target.instanceId'),
      projectId: requiredIdentifier(target.projectId, 'target.projectId'),
      threadId: requiredIdentifier(target.threadId, 'target.threadId'),
    },
    content,
    correlationId: optionalIdentifier(raw.correlationId, 'correlationId'),
    replyTo: optionalIdentifier(raw.replyTo, 'replyTo'),
    hopCount: hopCount as number,
  };
}
