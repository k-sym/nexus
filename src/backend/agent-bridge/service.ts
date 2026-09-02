import type Database from 'better-sqlite3';
import type { AgentBridgeConfig } from '@nexus/shared';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type ConsumerMessages,
} from '@nats-io/jetstream';
import { insertNotification } from '../notifications/index.js';
import { resolveEnvVars } from '../config.js';
import {
  AGENT_BRIDGE_STREAM,
  AGENT_BRIDGE_SUBJECT_PREFIX,
  bridgeSubject,
  parseAgentBridgeEnvelope,
  validateAgentBridgeConfig,
} from './protocol.js';
import { AgentBridgeStore, type BridgeIngestResult } from './store.js';

const RECONNECT_DELAY_MS = 5_000;
const STREAM_MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000;

export interface AgentBridgeStatus {
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'connected' | 'error';
  mode: AgentBridgeConfig['mode'];
  instanceId: string;
  subject: string;
  url: string;
  durable: true;
  error?: string;
}

export class AgentBridgeService {
  readonly store: AgentBridgeStore;
  private state: AgentBridgeStatus['state'];
  private error: string | undefined;
  private nc: NatsConnection | null = null;
  private messages: ConsumerMessages | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private readonly recentBySender = new Map<string, number[]>();

  constructor(
    private readonly db: Database.Database,
    readonly config: AgentBridgeConfig,
  ) {
    this.store = new AgentBridgeStore(db);
    this.store.recoverInterrupted();
    this.state = config.enabled ? 'connecting' : 'disabled';
  }

  status(): AgentBridgeStatus {
    return {
      enabled: this.config.enabled,
      state: this.state,
      mode: this.config.mode,
      instanceId: this.config.instance_id,
      subject: bridgeSubject(this.config.instance_id),
      url: redactNatsUrl(this.config.url),
      durable: true,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  start(): void {
    if (!this.config.enabled || this.stopping || this.nc) return;
    const invalid = validateAgentBridgeConfig({ ...this.config, token: resolveEnvVars(this.config.token) });
    if (invalid) {
      this.state = 'error';
      this.error = invalid;
      return;
    }
    this.state = 'connecting';
    void this.connectOnce();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.messages?.stop();
    this.messages = null;
    const nc = this.nc;
    this.nc = null;
    if (nc) await nc.drain().catch(() => nc.close());
    this.state = this.config.enabled ? 'error' : 'disabled';
  }

  ingest(value: unknown, nowMs = Date.now()): BridgeIngestResult {
    const envelope = parseAgentBridgeEnvelope(value, this.config.max_message_bytes, nowMs);
    const existing = this.store.get(envelope.id);
    if (existing) return { accepted: existing.status !== 'rejected', duplicate: true, message: existing };
    const rateLimited = this.recordAndCheckRate(envelope.sender.id, nowMs);
    const result = this.store.ingest(envelope, this.config, { rateLimited, receivedAt: new Date(nowMs).toISOString() });
    if (!result.duplicate && result.accepted) {
      const sender = envelope.sender.displayName || envelope.sender.id;
      insertNotification(this.db, {
        level: 'info',
        title: 'Agent Bridge',
        message: this.config.mode === 'queue_for_approval'
          ? `${sender} sent work to a Nexus thread. Approval is required in Settings.`
          : `${sender} sent a message to a Nexus thread.`,
      });
    }
    return result;
  }

  private recordAndCheckRate(senderId: string, nowMs: number): boolean {
    const cutoff = nowMs - 60_000;
    const recent = (this.recentBySender.get(senderId) ?? []).filter((time) => time > cutoff);
    const limited = recent.length >= this.config.max_messages_per_minute;
    recent.push(nowMs);
    this.recentBySender.set(senderId, recent);
    return limited;
  }

  private async connectOnce(): Promise<void> {
    let opened: NatsConnection | null = null;
    try {
      const token = resolveEnvVars(this.config.token).trim();
      const nc = await connect({
        servers: this.config.url,
        name: `nexus-agent-bridge-${this.config.instance_id}`,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2_000,
        timeout: 3_000,
        ...(token ? { token } : {}),
      });
      opened = nc;
      if (this.stopping) {
        await nc.drain();
        return;
      }
      this.nc = nc;
      await this.ensureDurableConsumer(nc);
      this.state = 'connected';
      this.error = undefined;
      void this.watchConnectionStatus(nc);
      void nc.closed().then((err) => {
        if (this.stopping || this.nc !== nc) return;
        this.nc = null;
        this.messages = null;
        this.state = 'error';
        this.error = err?.message || 'NATS connection closed';
        this.scheduleRetry();
      });
    } catch (error) {
      if (opened) await opened.close().catch(() => undefined);
      this.nc = null;
      this.messages = null;
      this.state = 'error';
      this.error = error instanceof Error ? error.message : 'Agent Bridge connection failed';
      this.scheduleRetry();
    }
  }

  private async ensureDurableConsumer(nc: NatsConnection): Promise<void> {
    const jsm = await jetstreamManager(nc);
    try {
      await jsm.streams.info(AGENT_BRIDGE_STREAM);
    } catch {
      await jsm.streams.add({
        name: AGENT_BRIDGE_STREAM,
        subjects: [`${AGENT_BRIDGE_SUBJECT_PREFIX}.*`],
        storage: StorageType.File,
        retention: RetentionPolicy.Limits,
        max_age: STREAM_MAX_AGE_NS,
        max_msgs_per_subject: 1_000,
        max_bytes: 64 * 1024 * 1024,
      });
    }

    const durable = `nexus_${this.config.instance_id}`;
    try {
      await jsm.consumers.info(AGENT_BRIDGE_STREAM, durable);
    } catch {
      await jsm.consumers.add(AGENT_BRIDGE_STREAM, {
        durable_name: durable,
        filter_subject: bridgeSubject(this.config.instance_id),
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        replay_policy: ReplayPolicy.Instant,
      });
    }
    const consumer = await jetstream(nc).consumers.get(AGENT_BRIDGE_STREAM, durable);
    const messages = await consumer.consume({ max_messages: 1 });
    this.messages = messages;
    void (async () => {
      try {
        for await (const message of messages) {
          try {
            this.ingest(message.json());
            // SQLite persistence/deduplication completed synchronously above.
            message.ack();
          } catch (error) {
            // Invalid/untrusted payloads cannot become valid through redelivery.
            // Database failures are retried because their errors don't match the
            // protocol validation messages.
            if (isDatabaseError(error)) message.nak(1_000);
            else message.term();
          }
        }
      } catch (error) {
        if (!this.stopping) {
          this.state = 'error';
          this.error = error instanceof Error ? error.message : 'Agent Bridge consumer failed';
          if (this.nc === nc) await nc.close().catch(() => undefined);
        }
      }
    })();
  }

  private async watchConnectionStatus(nc: NatsConnection): Promise<void> {
    for await (const status of nc.status()) {
      if (this.stopping || this.nc !== nc) return;
      if (status.type === 'disconnect' || status.type === 'reconnecting') {
        this.state = 'connecting';
        this.error = 'NATS connection interrupted; reconnecting';
      } else if (status.type === 'reconnect') {
        this.state = 'connected';
        this.error = undefined;
      } else if (status.type === 'error') {
        this.error = status.error.message;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, RECONNECT_DELAY_MS);
  }
}

function redactNatsUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function isDatabaseError(error: unknown): boolean {
  return error instanceof Error && /sqlite|database|constraint|readonly|locked/i.test(error.message);
}
