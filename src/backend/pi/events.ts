/**
 * A per-thread stream of pi session events, exposed as a Node Readable so
 * Fastify's reply.raw pipe pattern stays unchanged.
 *
 * Each chunk is a JSON-serialized event object. The consumer is the chat
 * route's NDJSON-over-HTTP transport. Aborts flip an internal flag that
 * the route checks before forwarding.
 */
import { Readable } from 'node:stream';

export class SessionEventStream extends Readable {
  private aborted = false;
  private reason: string | null = null;

  _read(): void {
    // Push is driven by emit() — no work to do here.
  }

  /** Forward a pi event. No-op if the stream was aborted. */
  emit(event: unknown): boolean {
    if (this.aborted) return false;
    return super.emit('data', event);
  }

  abort(reason: string): void {
    this.aborted = true;
    this.reason = reason;
  }

  abortReason(): string | null {
    return this.reason;
  }
}
