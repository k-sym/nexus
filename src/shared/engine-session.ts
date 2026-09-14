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

/**
 * Sync cursor for a thread whose Claude transcript is shared with the Claude
 * Desktop app (handed off or imported). Both sides resume the same SDK session
 * id; Nexus catches up by replaying the SDK transcript past `lastUuid` into
 * the thread's Pi JSONL. Appended after every reconcile, every Nexus turn and
 * at import, so it travels with the thread like `nexus.engine_session`.
 */
export const DESKTOP_SYNC_CUSTOM_TYPE = 'nexus.desktop_sync' as const;

export interface DesktopSyncRecord {
  /** `uuid` of the last SDK transcript message mirrored into the Pi JSONL; empty for a transcript with no messages yet. */
  lastUuid: string;
  /** Message count at that point — the offset fallback when `lastUuid` cannot be found. */
  messageCount: number;
  /** Transcript file size at that point; an unchanged size skips the read. */
  fileSize: number;
  syncedAt: string;
}

/** One Claude Desktop or terminal session that could become a Nexus thread. */
export interface DesktopSessionSummary {
  /** The Claude Code session id (`~/.claude/projects/<slug>/<id>.jsonl`). */
  id: string;
  /** Custom title, auto summary or first prompt — whatever the SDK reports. */
  title: string;
  first_prompt: string | null;
  /** ISO timestamp of the transcript's last modification. */
  last_modified: string;
  created_at: string | null;
  git_branch: string | null;
  cwd: string | null;
}
