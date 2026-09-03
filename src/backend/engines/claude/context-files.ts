/**
 * Project context files (`AGENTS.md`/`CLAUDE.md`) for Claude engine sessions.
 *
 * Pi sessions get these through Pi's own resource loader; Claude sessions are
 * run with `settingSources` scoped down (or empty, by default) so the SDK
 * itself may not read `CLAUDE.md` from the project. This module reuses Pi's
 * own loader (`loadProjectContextFiles`) so both engines see the same files
 * resolved the same way, and folds them into the Claude session's
 * system-prompt appendix — without ever duplicating a file the SDK is
 * already going to load itself (see `selectContextFiles`).
 */
import { basename } from 'node:path';
import { loadProjectContextFiles } from '@earendil-works/pi-coding-agent';

export interface ContextFile {
  path: string;
  content: string;
}

/** Cap per file; a truncated file still gives the model useful context
 *  without risking runaway prompt size from a giant AGENTS.md. */
export const CONTEXT_FILE_MAX_CHARS = 24_000;

/** Drops `CLAUDE.md`/`CLAUDE.MD` when `'project'` is among the configured
 *  setting sources — in that case the SDK loads it itself, and appending it
 *  here too would inject it twice. */
export function selectContextFiles(files: ContextFile[], settingSources: string[]): ContextFile[] {
  if (!settingSources.includes('project')) return files;
  return files.filter((file) => basename(file.path).toLowerCase() !== 'claude.md');
}

function truncate(content: string): string {
  if (content.length <= CONTEXT_FILE_MAX_CHARS) return content;
  return `${content.slice(0, CONTEXT_FILE_MAX_CHARS)}\n\n[truncated]`;
}

/** Formats each file as a labeled block; `''` when there is nothing to add. */
export function formatContextFiles(files: ContextFile[]): string {
  if (files.length === 0) return '';
  return files.map((file) => `# Project instructions (${basename(file.path)})\n\n${truncate(file.content)}`).join('\n\n');
}

/**
 * Reads the project's context files via Pi's own loader, drops what the SDK
 * will load itself, and formats the rest for the system-prompt appendix.
 *
 * `loadProjectContextFiles` reads the first `AGENTS.override.md` / `AGENTS.md`
 * / `CLAUDE.md` it finds in `cwd`, and does the same in every ancestor
 * directory up to `/` (so e.g. a `~/AGENTS.md` is picked up), plus one more
 * from `agentDir` (`~/.nexus/sessions`) — matching Pi's and Claude Code's own
 * lookup. This is intentional, not a bug: deliberately keep it.
 *
 * Never throws — a read failure (missing directory, permissions) yields ''
 * rather than failing the turn.
 */
export function projectContextAppendix(cwd: string, agentDir: string, settingSources: string[]): string {
  try {
    const files = loadProjectContextFiles({ cwd, agentDir });
    return formatContextFiles(selectContextFiles(files, settingSources));
  } catch {
    return '';
  }
}
