import { connect, type NatsConnection } from '@nats-io/transport-node';
import { AckPolicy, DeliverPolicy, ReplayPolicy, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { createHash } from 'node:crypto';
import { validateConfig, type ClientConfig } from './config.js';
import { State } from './state.js';
import { discover, resolveTarget } from './targets.js';
import { envelope, identifier, inboxSubject, parseResult, resultsSubject, RESULTS_STREAM, type Result } from './protocol.js';
export interface SendInput { project?: string; thread?: string; content?: string; correlationId?: string; retryId?: string }
export interface Batch { results: Result[]; delivered(): void; release(): void }
export class BridgeClient {
  readonly config: ClientConfig;
  readonly state: State;
  private connections = new Set<NatsConnection>();
  constructor(config: ClientConfig) { this.config = validateConfig(config); this.state = new State(this.config); }
  private async connection(signal?: AbortSignal): Promise<NatsConnection> {
    signal?.throwIfAborted();
    const nc = await connect({ servers: this.config.url, token: this.config.token || undefined, timeout: 2000, reconnect: false });
    if (signal?.aborted) { await nc.close(); signal.throwIfAborted(); }
    this.connections.add(nc); return nc;
  }
  private async disconnect(nc?: NatsConnection): Promise<void> { if (nc) { this.connections.delete(nc); await nc.close(); } }
  async send(input: SendInput, signal?: AbortSignal) {
    let message;
    if (input.retryId !== undefined) {
      identifier(input.retryId, 'retry ID');
      if ([input.project, input.thread, input.content, input.correlationId].some(value => value !== undefined)) throw new Error('retryId cannot be combined with a new target, content or correlation.');
      message = this.state.send(input.retryId);
      if (!message) throw new Error('No stored send with this retry ID for the configured sender and instance.');
    } else {
      if (typeof input.project !== 'string' || typeof input.thread !== 'string' || typeof input.content !== 'string') throw new Error('A new send requires project, thread and content.');
      const targets = await discover(this.config, signal);
      message = envelope(this.config.sender_id, resolveTarget(targets, input.project, input.thread), input.content, targets.maxMessageBytes, input.correlationId);
      this.state.saveSend(message);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let nc: NatsConnection | undefined;
      try {
        nc = await this.connection(signal);
        await jetstream(nc, { timeout: 2000 }).publish(inboxSubject(this.config.instance_id), new TextEncoder().encode(JSON.stringify(message)), { msgID: message.id });
        this.state.published(message.id);
        return { id: message.id, target: message.target, brokerAccepted: true, message: 'Broker accepted the message. Nexus still applies sender/scope checks; queued work needs Run approval and results need Send reply approval.' };
      } catch { if (signal?.aborted) break; }
      finally { await this.disconnect(nc); }
    }
    throw new Error(`Publication was not confirmed. Retry the original envelope with nexus-bridge send --retry ${message.id}`);
  }
  async readBatch(signal?: AbortSignal): Promise<Batch> {
    const release = this.state.lockReader();
    let nc: NatsConnection | undefined;
    try {
      let results = this.state.unread();
      if (!results.length) {
        nc = await this.connection(signal);
        const jsm = await jetstreamManager(nc, { timeout: 2000 });
        const durable = `client_${createHash('sha256').update(`${this.config.sender_id}:${this.config.instance_id}`).digest('hex').slice(0, 32)}`;
        // Add is idempotent when the existing durable has the same configuration.
        await jsm.consumers.add(RESULTS_STREAM, { durable_name: durable, filter_subject: resultsSubject(this.config.sender_id),
          ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, replay_policy: ReplayPolicy.Instant, max_ack_pending: 100 });
        const consumer = await jetstream(nc, { timeout: 2000 }).consumers.get(RESULTS_STREAM, durable);
        const messages = await consumer.fetch({ max_messages: 100, expires: 1000 });
        const abort = () => { messages.stop(); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        try {
          for await (const message of messages) {
            let result: Result;
            try { result = parseResult(message.data, this.config.sender_id, this.config.instance_id); }
            catch { message.term(); continue; }
            // Persist before broker ack. Storage failure leaves the broker delivery unacked.
            this.state.receive(result); message.ack();
          }
        } finally { signal?.removeEventListener('abort', abort); messages.stop(); }
        results = this.state.unread();
      }
      return { results, release, delivered: () => { this.state.delivered(results.map(result => result.id)); release(); } };
    } catch {
      release();
      throw new Error('Could not read bridge results; check broker access and whether Nexus has started its results stream.');
    } finally { await this.disconnect(nc); }
  }
  async close(): Promise<void> {
    await Promise.all([...this.connections].map(nc => this.disconnect(nc)));
    this.state.close();
  }
}
