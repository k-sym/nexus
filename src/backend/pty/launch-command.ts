const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** POSIX single-quote a string for safe inclusion in a shell command. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchOpts {
  provider: string;
  systemPrompt?: string;
  sessionId?: string | null;
}

/**
 * Build the command pre-typed (not executed) into a fresh terminal thread.
 * Persona context rides in via the CLI's own system-prompt flag — the repo is never mutated.
 * Returns '' for providers without a terminal CLI (plain shell).
 */
export function buildLaunchCommand({ provider, systemPrompt, sessionId }: LaunchOpts): string {
  if (provider === 'claude_code') {
    if (sessionId && SAFE_SESSION_ID.test(sessionId)) return `claude --resume ${sessionId}`;
    if (systemPrompt && systemPrompt.trim()) return `claude --append-system-prompt ${shellSingleQuote(systemPrompt)}`;
    return 'claude';
  }
  if (provider === 'codex') return 'codex';
  return '';
}
