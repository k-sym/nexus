const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** POSIX single-quote a string for safe inclusion in a shell command. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Split a free-form CLI args string into argv (whitespace split). */
function splitArgs(s: string | null | undefined): string[] {
  return (s ?? '').trim().split(/\s+/).filter(Boolean);
}

export interface LaunchOpts {
  providerKind: string;            // 'claude_code' | 'codex' | 'opencode' | other
  model?: string | null;
  args?: string | null;            // provider's free-form launch args (opencode)
  systemPrompt?: string;
  sessionId?: string | null;
}

/**
 * Build the command pre-typed (not executed) into a fresh terminal thread.
 * Persona context rides in via the CLI's own system-prompt flag — the repo is never mutated.
 * Returns '' for providers without a terminal CLI (plain shell).
 */
export function buildLaunchCommand({ providerKind, model, args, systemPrompt, sessionId }: LaunchOpts): string {
  if (providerKind === 'claude_code') {
    if (sessionId && SAFE_SESSION_ID.test(sessionId)) return `claude --resume ${sessionId}`;
    if (systemPrompt && systemPrompt.trim()) return `claude --append-system-prompt ${shellSingleQuote(systemPrompt)}`;
    return 'claude';
  }
  if (providerKind === 'codex') return 'codex';
  if (providerKind === 'opencode') {
    // Interactive TUI parity with chat's `opencode run --model <m> <args>` (minus run/prompt).
    return ['opencode', ...(model ? ['--model', model] : []), ...splitArgs(args)].join(' ');
  }
  return '';
}
