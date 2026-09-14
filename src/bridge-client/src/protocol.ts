import { randomUUID } from 'node:crypto';
export const RESULTS_STREAM = 'NEXUS_AGENT_BRIDGE_RESULTS_V1';
export const inboxSubject = (instance: string) => `nexus.bridge.v1.inbox.${instance}`;
export const resultsSubject = (sender: string) => `nexus.bridge.v1.results.${Buffer.from(sender).toString('base64url')}`;
export function identifier(value: unknown, field = 'ID'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Configure a valid ${field} (1–128 identifier characters).`);
}
export function instanceIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Configure a valid instance ID (1–64 letters, numbers, underscores or hyphens).');
}
export interface Envelope {
  version: 1; kind: 'message'; id: string; sentAt: string;
  sender: { id: string; harness: 'nexus-bridge-client' };
  target: { instanceId: string; projectId: string; threadId: string };
  content: string; replyTo: string; hopCount: 0; correlationId?: string;
}
export function envelope(sender: string, target: Envelope['target'], content: string, maxBytes: number, correlationId?: string): Envelope {
  identifier(sender); instanceIdentifier(target.instanceId); identifier(target.projectId); identifier(target.threadId);
  if (correlationId !== undefined) identifier(correlationId, 'correlation ID');
  if (!content.trim() || Buffer.byteLength(content.trim()) > maxBytes) throw new Error('Message is empty or exceeds the backend message size limit.');
  return { version: 1, kind: 'message', id: randomUUID(), sentAt: new Date().toISOString(), sender: { id: sender, harness: 'nexus-bridge-client' }, target,
    content: content.trim(), replyTo: sender, hopCount: 0, ...(correlationId === undefined ? {} : { correlationId }) };
}
export interface Result {
  version: 1; kind: 'result'; id: string; sentAt: string; inReplyTo: string; correlationId: string;
  sender: { id: string }; target: { senderId: string }; status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; content: string; error?: string;
}
export function parseResult(data: Uint8Array, sender: string, instance: string): Result {
  if (data.byteLength > 131072) throw new Error('Oversized result.');
  const r = JSON.parse(new TextDecoder().decode(data));
  if (!r || r.version !== 1 || r.kind !== 'result' || r.target?.senderId !== sender || r.sender?.id !== instance) throw new Error('Result is not addressed to this client.');
  for (const key of ['id', 'inReplyTo', 'correlationId']) identifier(r[key]);
  if (typeof r.sentAt !== 'string' || !Number.isFinite(Date.parse(r.sentAt)) || !['completed', 'failed', 'cancelled', 'interrupted'].includes(r.status) ||
    typeof r.content !== 'string' || r.content.length > 8000 || (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 2000))) throw new Error('Invalid result.');
  return { version: 1, kind: 'result', id: r.id, sentAt: r.sentAt, inReplyTo: r.inReplyTo, correlationId: r.correlationId,
    sender: { id: instance }, target: { senderId: sender }, status: r.status, content: r.content, ...(r.error === undefined ? {} : { error: r.error }) };
}
