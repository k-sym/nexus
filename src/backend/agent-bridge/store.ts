import { randomUUID } from 'node:crypto';
import type { AgentBridgeReply, AgentBridgeResultEnvelope, AgentBridgeProjectPolicy, AgentBridgeProjectScope } from '@nexus/shared';
import { bridgeResultSubject } from './protocol.js';
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

  projects(): AgentBridgeProjectScope[] {
    const projects = this.db.prepare(`SELECT p.id, p.name, COALESCE(b.enabled, 0) AS enabled, b.thread_ids
      FROM projects p LEFT JOIN agent_bridge_project_policy b ON b.project_id = p.id
      ORDER BY p.name, p.id`).all() as Array<{ id: string; name: string; enabled: number; thread_ids: string | null }>;
    const threads = this.db.prepare('SELECT id, title, project_id FROM chat_threads ORDER BY title, id').all() as
      Array<{ id: string; title: string; project_id: string }>;
    return projects.map(project => ({
      id: project.id, name: project.name, enabled: project.enabled === 1,
      thread_ids: project.thread_ids === null ? null : JSON.parse(project.thread_ids),
      threads: threads.filter(thread => thread.project_id === project.id).map(({ id, title }) => ({ id, title })),
    }));
  }

  setPolicy(projectId: string, policy: AgentBridgeProjectPolicy): void {
    this.db.prepare(`INSERT INTO agent_bridge_project_policy (project_id, enabled, thread_ids) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, thread_ids = excluded.thread_ids`)
      .run(projectId, Number(policy.enabled), policy.thread_ids === null ? null : JSON.stringify(policy.thread_ids));
  }

  scopeRejection(projectId: string, threadId: string): string | null {
    const policy = this.db.prepare('SELECT enabled, thread_ids FROM agent_bridge_project_policy WHERE project_id = ?')
      .get(projectId) as { enabled: number; thread_ids: string | null } | undefined;
    if (policy?.enabled !== 1) return 'project_not_enabled';
    if (policy.thread_ids !== null && !(JSON.parse(policy.thread_ids) as string[]).includes(threadId)) return 'thread_not_enabled';
    const thread = this.db.prepare('SELECT project_id FROM chat_threads WHERE id = ?').get(threadId) as
      { project_id: string } | undefined;
    if (!thread) return 'target thread was not found';
    if (thread.project_id !== projectId) return 'target thread does not belong to the target project';
    return null;
  }

  /** Preserve unresolved work and unsent replies, even after their age limit. */
  prune(retentionDays: number, nowMs = Date.now()): number {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) return 0;
    const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
    return this.db.transaction(() => {
      const eligible = this.db.prepare(`SELECT m.id FROM agent_bridge_messages m
        LEFT JOIN agent_bridge_replies r ON r.message_id = m.id
        WHERE m.status IN ('received', 'completed', 'rejected', 'failed') AND m.updated_at < ?
          AND (r.id IS NULL OR (r.status IN ('sent', 'discarded')
            AND COALESCE(r.discarded_at, r.sent_at, m.updated_at) < ?))`).all(cutoff, cutoff) as Array<{ id: string }>;
      const deleteReply = this.db.prepare('DELETE FROM agent_bridge_replies WHERE message_id = ?');
      const deleteMessage = this.db.prepare('DELETE FROM agent_bridge_messages WHERE id = ?');
      for (const { id } of eligible) { deleteReply.run(id); deleteMessage.run(id); }
      return eligible.length;
    })();
  }

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

    if (!rejection) rejection = this.scopeRejection(envelope.target.projectId, envelope.target.threadId);

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

  reply(messageId: string): AgentBridgeReply | undefined {
    return this.db.prepare('SELECT * FROM agent_bridge_replies WHERE message_id = ?').get(messageId) as AgentBridgeReply | undefined;
  }

  complete(message: AgentBridgeMessage, result: { completed: boolean; status?: AgentBridgeResultEnvelope['status']; content?: string; error?: string }, instanceId: string): void {
    this.db.transaction(() => {
      if (!this.transition(message.id, 'running', result.completed ? 'completed' : 'failed', result.error)) return;
      const envelope: AgentBridgeResultEnvelope = {
        version: 1, kind: 'result', id: randomUUID(), sentAt: new Date().toISOString(),
        inReplyTo: message.id, correlationId: message.correlation_id || message.id,
        sender: { id: instanceId }, target: { senderId: message.sender_id },
        status: result.status ?? (result.completed ? 'completed' : 'failed'),
        content: (result.content || '').slice(0, 8000),
        ...(result.error ? { error: result.error.slice(0, 2000) } : {}),
      };
      this.db.prepare('INSERT INTO agent_bridge_replies (id, message_id, destination, payload) VALUES (?, ?, ?, ?)')
        .run(envelope.id, message.id, bridgeResultSubject(message.sender_id), JSON.stringify(envelope));
    })();
  }

  approveReply(messageId: string): AgentBridgeReply | undefined {
    this.db.prepare("UPDATE agent_bridge_replies SET status = 'queued' WHERE message_id = ? AND status = 'pending_approval'").run(messageId);
    return this.reply(messageId);
  }

  queuedReplies(): AgentBridgeReply[] {
    return this.db.prepare("SELECT * FROM agent_bridge_replies WHERE status = 'queued'").all() as AgentBridgeReply[];
  }

  markReplySent(id: string): void {
    this.db.prepare("UPDATE agent_bridge_replies SET status = 'sent', sent_at = ?, error = NULL WHERE id = ? AND status = 'queued'")
      .run(new Date().toISOString(), id);
  }

  markReplyError(id: string, error: string, maxAttempts: number): void {
    this.db.prepare(`UPDATE agent_bridge_replies SET error = ?, attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= ? THEN 'dead_letter' ELSE 'queued' END
      WHERE id = ? AND status = 'queued'`).run(error.slice(0, 2000), maxAttempts, id);
  }

  retryReply(messageId: string): AgentBridgeReply | undefined {
    const result = this.db.prepare(`UPDATE agent_bridge_replies SET status = 'queued', attempts = 0, error = NULL
      WHERE message_id = ? AND status = 'dead_letter'`).run(messageId);
    return result.changes ? this.reply(messageId) : undefined;
  }

  discardReply(messageId: string): AgentBridgeReply | undefined {
    const result = this.db.prepare(`UPDATE agent_bridge_replies SET status = 'discarded', discarded_at = ?, discarded_by = 'user'
      WHERE message_id = ? AND status = 'dead_letter'`).run(new Date().toISOString(), messageId);
    return result.changes ? this.reply(messageId) : undefined;
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
