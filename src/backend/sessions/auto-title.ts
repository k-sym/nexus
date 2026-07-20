/**
 * Auto-naming for new sessions.
 *
 * A session is born with a placeholder title ('New Session' / 'New Assistant
 * Session'). On the first user turn we ask the local model for a short name
 * derived from the opening prompt, so the sidebar reads like a task list
 * instead of a column of identical placeholders.
 *
 * Two rules keep this from ever fighting the user:
 *  - we only act when the title is still the exact placeholder, so a session
 *    the user renamed — or one seeded from a task title — is left alone;
 *  - the UPDATE repeats the placeholder in its WHERE clause, so a rename that
 *    lands during the ~1-2s generation wins the race instead of being clobbered.
 *
 * Failure is silent by design: this runs alongside a live chat turn, and an
 * unreachable daemon or a slow model must never degrade it. The placeholder
 * simply survives, and the user can rename by hand as before.
 */
import type Database from 'better-sqlite3';
import { daemon } from '../memory/client.js';

/** Must match the SQL defaults on chat_threads / assistant_sessions in db.ts. */
export const NEW_THREAD_TITLE = 'New Session';
export const NEW_ASSISTANT_SESSION_TITLE = 'New Assistant Session';

/** Below this a prompt ('hi', 'ok?') carries no topic worth a model round-trip. */
const MIN_PROMPT_CHARS = 12;
/** The model only needs the opening intent; a pasted stack trace adds latency, not signal. */
const MAX_PROMPT_CHARS = 2000;

export interface AutoTitleTarget {
  /** Literal union, not caller input — safe to interpolate into the statement. */
  table: 'chat_threads' | 'assistant_sessions';
  id: string;
  currentTitle: string;
  placeholder: string;
}

export interface AutoTitleDeps {
  generate?: (prompt: string) => Promise<string>;
}

export function shouldAutoTitle(currentTitle: string, placeholder: string, prompt: string): boolean {
  if (currentTitle.trim() !== placeholder) return false;
  return prompt.replace(/\s+/g, ' ').trim().length >= MIN_PROMPT_CHARS;
}

/**
 * Returns the new title if one was generated and written, else null. Never throws.
 *
 * Deliberately does not touch `updated_at`: naming a session is not activity,
 * and the sidebar sorts on that column.
 */
export async function autoTitleSession(
  db: Database.Database,
  target: AutoTitleTarget,
  prompt: string,
  deps: AutoTitleDeps = {},
): Promise<string | null> {
  if (!shouldAutoTitle(target.currentTitle, target.placeholder, prompt)) return null;

  const generate = deps.generate ?? generateWithMemoryDaemon;
  let title: string;
  try {
    title = (await generate(prompt.trim().slice(0, MAX_PROMPT_CHARS))).trim();
  } catch (err: any) {
    console.error(`[auto-title] ${target.table} ${target.id}:`, err?.message);
    return null;
  }
  if (!title) return null;

  try {
    const result = db
      .prepare(`UPDATE ${target.table} SET title = ? WHERE id = ? AND title = ?`)
      .run(title, target.id, target.placeholder);
    return result.changes > 0 ? title : null;
  } catch (err: any) {
    console.error(`[auto-title] write failed for ${target.table} ${target.id}:`, err?.message);
    return null;
  }
}

async function generateWithMemoryDaemon(prompt: string): Promise<string> {
  const res = await daemon.generateSessionTitle({ prompt });
  return String(res.title ?? '');
}
