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
import type { NexusConfig } from '@nexus/shared';
import { daemon } from '../memory/client.js';
import { loadConfig } from '../config.js';
import { runClaudeOneShot } from '../engines/claude/one-shot.js';
import { CLAUDE_CODE_PROVIDER, findClaudeModel } from '../engines/claude/models.js';

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

  const generate = deps.generate ?? generateWithConfiguredModel;
  try {
    return (await generate(renderTranscript(turns))).trim();
  } catch (err: any) {
    console.error('[next-message]', err?.message);
    return '';
  }
}

/** Same words the memory daemon uses, so the two generators are interchangeable. */
export const NEXT_MESSAGE_SYSTEM_PROMPT =
  "You predict the user's next message in a coding session. Read the transcript and reply with the single most likely thing the user will say next, in their voice, as a short instruction or question. Reply with that message alone: no quotes, no preamble, no explanation. Reply with nothing at all if the next move is not predictable.";

/** A late suggestion is discarded by the composer anyway; this only stops a
 *  wedged call from pinning the request open. */
export const NEXT_MESSAGE_TIMEOUT_MS = 20_000;

export type NextMessageGenerator =
  | { kind: 'claude'; modelId: string }
  | { kind: 'daemon' };

/** Which generator `models.next_message` selects (#434). Only a `claude-code/*`
 *  key with the engine enabled and a known model id goes to Claude; anything
 *  else (empty, another provider, engine off, unknown id) is the daemon. */
export function resolveNextMessageGenerator(config: Pick<NexusConfig, 'models' | 'engines'>): NextMessageGenerator {
  const key = (config.models.next_message ?? '').trim();
  const sep = key.indexOf('/');
  if (sep <= 0) return { kind: 'daemon' };
  const provider = key.slice(0, sep);
  const modelId = key.slice(sep + 1);
  if (provider !== CLAUDE_CODE_PROVIDER || !modelId) return { kind: 'daemon' };
  if (!config.engines.claude.enabled || !findClaudeModel(modelId)) return { kind: 'daemon' };
  return { kind: 'claude', modelId };
}

/** Mirror of the daemon's `cleanSuggestion`: first line, no label, no quotes. */
export function cleanSuggestion(raw: string): string {
  const firstLine = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine
    .replace(/^(?:next\s+message|suggestion|user|message)\s*:\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim();
}

/** Claude when configured, the daemon otherwise — and the daemon again when
 *  Claude fails, so a Sonnet hiccup degrades to the old behaviour rather than
 *  to no suggestion. */
async function generateWithConfiguredModel(transcript: string): Promise<string> {
  const config = loadConfig();
  const generator = resolveNextMessageGenerator(config);
  if (generator.kind === 'claude') {
    try {
      const text = await runClaudeOneShot(config.engines.claude, {
        modelId: generator.modelId,
        systemPrompt: NEXT_MESSAGE_SYSTEM_PROMPT,
        prompt: transcript,
        timeoutMs: NEXT_MESSAGE_TIMEOUT_MS,
      });
      return cleanSuggestion(text);
    } catch (err: any) {
      console.error('[next-message] claude one-shot failed, falling back to daemon:', err?.message);
    }
  }
  return generateWithMemoryDaemon(transcript);
}

async function generateWithMemoryDaemon(transcript: string): Promise<string> {
  const res = await daemon.generateNextMessage({ transcript });
  return String(res.suggestion ?? '');
}
