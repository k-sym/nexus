/**
 * Predict the user's next message from the tail of a conversation.
 *
 * The caller supplies the transcript rather than the server re-reading it: every
 * surface that wants a suggestion (chat, assistant, the glasses cockpit) is
 * already holding the messages it has just rendered, so this stays stateless —
 * no db reads, no session resolution, no per-surface code.
 *
 * Failure is silent by design, exactly as in `auto-title.ts`. This runs after a
 * chat turn has already completed, and a suggestion is a courtesy: an
 * unreachable daemon or a slow model must produce no placeholder, never an
 * error the user has to acknowledge.
 */
import { daemon } from '../memory/client.js';

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** The model only needs the recent tail; older turns add latency, not signal. */
export const MAX_TURNS = 20;
/** One pasted stack trace should not crowd out the surrounding conversation. */
export const MAX_TURN_CHARS = 2000;
/** Total prompt ceiling, sized so a queued call still returns inside the timeout. */
export const MAX_CONTEXT_CHARS = 8000;

export interface NextMessageDeps {
  generate?: (transcript: string) => Promise<string>;
}

/** Returns the bounded turns, or null when the input is not a transcript at all. */
export function parseTranscript(value: unknown): TranscriptTurn[] | null {
  if (!Array.isArray(value)) return null;
  const turns: TranscriptTurn[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { role, text } = raw as { role?: unknown; text?: unknown };
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof text !== 'string') return null;
    turns.push({ role, text: text.slice(0, MAX_TURN_CHARS) });
  }
  return turns.slice(-MAX_TURNS);
}

/** Flatten to the labelled form the daemon's archive summariser already uses. */
export function renderTranscript(turns: TranscriptTurn[]): string {
  const rendered = turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n\n');
  // Truncate from the front: the newest turns carry the intent being predicted.
  return rendered.length > MAX_CONTEXT_CHARS ? rendered.slice(-MAX_CONTEXT_CHARS) : rendered;
}

/** Returns the suggestion, or '' for "nothing worth offering". Never throws. */
export async function suggestNextMessage(
  turns: TranscriptTurn[],
  deps: NextMessageDeps = {},
): Promise<string> {
  // Nothing to predict from until the assistant has actually said something.
  if (!turns.some((turn) => turn.role === 'assistant' && turn.text.trim())) return '';

  const generate = deps.generate ?? generateWithMemoryDaemon;
  try {
    return (await generate(renderTranscript(turns))).trim();
  } catch (err: any) {
    console.error('[next-message]', err?.message);
    return '';
  }
}

async function generateWithMemoryDaemon(transcript: string): Promise<string> {
  const res = await daemon.generateNextMessage({ transcript });
  return String(res.suggestion ?? '');
}
