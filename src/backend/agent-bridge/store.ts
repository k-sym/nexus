import type Database from 'better-sqlite3';
import type { AgentBridgeConfig, AgentBridgeMode } from '@nexus/shared';
import type { AgentBridgeEnvelopeV1 } from './protocol.js';

export type AgentBridgeMessageStatus =
  | 'received'
  | 'pending_approval'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface AgentBridgeMessage {
  id: string;
  protocol_version: number;
  sender_id: string;
  sender_display_name: string | null;
  sender_harness: string | null;
  target_instance_id: string;
  project_id: string;
  thread_id: string;
  content: string;
  correlation_id: string | null;
  reply_to: string | null;
  hop_count: number;
  status: AgentBridgeMessageStatus;
  rejection_reason: string | null;
  received_at: string;
  sent_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface BridgeIngestResult {
  accepted: boolean;
  duplicate: boolean;
  message: AgentBridgeMessage;
}

export class AgentBridgeStore {
  constructor(private readonly db: Database.Database) {}

  /** A process crash can cut off a managed chat turn after acceptance. Put the
   * durable work back in the human queue instead of leaving it permanently
   * stuck as running or silently replaying it on startup. */
  recoverInterrupted(): number {
    const now = new Date().toISOString();
    return this.db.prepare(`
      UPDATE agent_bridge_messages
      SET status = 'pending_approval',
          rejection_reason = 'Interrupted by a backend restart; approve to retry',
          updated_at = ?,
          completed_at = NULL
      WHERE status = 'running'
    `).run(now).changes;
  }

  get(id: string): AgentBridgeMessage | undefined {
    return this.db.prepare('SELECT * FROM agent_bridge_messages WHERE id = ?').get(id) as AgentBridgeMessage | undefined;
  }

  list(options: { status?: AgentBridgeMessageStatus; limit?: number } = {}): AgentBridgeMessage[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    if (options.status) {
      return this.db.prepare(
        'SELECT * FROM agent_bridge_messages WHERE status = ? ORDER BY received_at DESC, rowid DESC LIMIT ?',
      ).all(options.status, limit) as AgentBridgeMessage[];
    }
    return this.db.prepare(
      'SELECT * FROM agent_bridge_messages ORDER BY received_at DESC, rowid DESC LIMIT ?',
    ).all(limit) as AgentBridgeMessage[];
  }

  ingest(
    envelope: AgentBridgeEnvelopeV1,
    config: AgentBridgeConfig,
    options: { rateLimited?: boolean; receivedAt?: string } = {},
  ): BridgeIngestResult {
    const existing = this.get(envelope.id);
    if (existing) return { accepted: existing.status !== 'rejected', duplicate: true, message: existing };

    let rejection: string | null = null;
    if (envelope.target.instanceId !== config.instance_id) rejection = 'target instance does not match this Nexus instance';
    else if (!(config.allowed_senders.includes('*') || config.allowed_senders.includes(envelope.sender.id))) rejection = 'sender is not allowed';
    else if ((envelope.hopCount ?? 0) > config.max_hops) rejection = 'hop limit exceeded';
    else if (options.rateLimited) rejection = 'sender rate limit exceeded';

    const thread = this.db.prepare('SELECT project_id FROM chat_threads WHERE id = ?').get(envelope.target.threadId) as
      { project_id: string } | undefined;
    if (!rejection && !thread) rejection = 'target thread was not found';
    if (!rejection && thread?.project_id !== envelope.target.projectId) rejection = 'target thread does not belong to the target project';

    const now = options.receivedAt ?? new Date().toISOString();
    const status: AgentBridgeMessageStatus = rejection
      ? 'rejected'
      : initialStatus(config.mode);
    this.db.prepare(`
      INSERT INTO agent_bridge_messages (
        id, protocol_version, sender_id, sender_display_name, sender_harness,
        target_instance_id, project_id, thread_id, content, correlation_id,
        reply_to, hop_count, status, rejection_reason, received_at, sent_at,
        updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      envelope.id,
      envelope.version,
      envelope.sender.id,
      envelope.sender.displayName ?? null,
      envelope.sender.harness ?? null,
      envelope.target.instanceId,
      envelope.target.projectId,
      envelope.target.threadId,
      envelope.content,
      envelope.correlationId ?? null,
      envelope.replyTo ?? null,
      envelope.hopCount ?? 0,
      status,
      rejection,
      now,
      envelope.sentAt,
      now,
    );
    return { accepted: !rejection, duplicate: false, message: this.get(envelope.id)! };
  }

  transition(
    id: string,
    from: AgentBridgeMessageStatus | AgentBridgeMessageStatus[],
    to: AgentBridgeMessageStatus,
    error?: string,
  ): AgentBridgeMessage | undefined {
    const sources = Array.isArray(from) ? from : [from];
    const placeholders = sources.map(() => '?').join(', ');
    const now = new Date().toISOString();
    const terminal = ['completed', 'rejected', 'failed'].includes(to) ? now : null;
    const result = this.db.prepare(`
      UPDATE agent_bridge_messages
      SET status = ?, rejection_reason = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND status IN (${placeholders})
    `).run(to, error ?? null, now, terminal, id, ...sources);
    return result.changes > 0 ? this.get(id) : undefined;
  }
}

function initialStatus(mode: AgentBridgeMode): AgentBridgeMessageStatus {
  return mode === 'queue_for_approval' ? 'pending_approval' : 'received';
}
