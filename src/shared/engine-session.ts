/**
 * Session entry written by non-Pi engines into the thread's JSONL so a later
 * turn can resume the engine's own conversation. Stored beside the messages
 * (not in nexus.db) so drop/tombstone/archive semantics carry it for free.
 * `PiRuntime.readMessages` filters custom entries other than run markers, so
 * this never reaches `flattenEntries`.
 */
export const ENGINE_SESSION_CUSTOM_TYPE = 'nexus.engine_session' as const;

export interface EngineSessionRecord {
  engine: 'claude-code';
  /** The engine's own session id (for the Claude Agent SDK, the `session_id` from its `init` message). */
  sessionId: string;
  recordedAt: string;
}
