/**
 * Ask the backend for the user's likely next message once a turn completes.
 *
 * Fires after the stream has closed rather than riding on it: the suggestion is
 * only computable once the reply exists, and holding `run_end` open to wait for
 * it would make every turn look slower to save one round-trip.
 *
 * Silent on failure, by contract. No toast, no banner, no retry — an offline
 * daemon simply means no placeholder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api-base';

export interface SuggestionMessage {
  role: string;
  content: string;
}

export interface UseNextSuggestionInput {
  /** The surface's own id (threadId / assistant sessionId). Staleness token only — never sent. */
  sessionKey: string | null;
  /** Trailing assistant message id. Changes once per turn: trigger and staleness token. */
  turnKey: string | null;
  messages: SuggestionMessage[];
  /** Caller-owned predicate: composer empty && the turn ended cleanly. */
  enabled: boolean;
}

function toTranscript(messages: SuggestionMessage[]) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => ({ role: m.role, text: m.content }));
}

export function useNextSuggestion({ sessionKey, turnKey, messages, enabled }: UseNextSuggestionInput) {
  const [suggestion, setSuggestion] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  // Turns already handled — so a dismissed suggestion never returns for the same
  // turn, and a re-render never re-fires an in-flight or completed request.
  const handledRef = useRef<string | null>(null);
  // Read inside the effect without making message identity a trigger: the
  // transcript is a snapshot taken when the turn ends, not a live dependency.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const dismiss = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSuggestion('');
  }, []);

  // A new session starts clean: any in-flight request belongs to the old one.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    handledRef.current = null;
    setSuggestion('');
  }, [sessionKey]);

  useEffect(() => {
    if (!enabled || !turnKey || handledRef.current === turnKey) return;
    const transcript = toTranscript(messagesRef.current);
    if (transcript.length === 0) return;

    handledRef.current = turnKey;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestedFor = { sessionKey, turnKey };

    void (async () => {
      try {
        const res = await apiFetch('/api/next-message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcript }),
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = (await res.json()) as { suggestion?: string };
        // The world may have moved on while the local model was thinking.
        if (controller.signal.aborted) return;
        if (requestedFor.sessionKey !== sessionKey || requestedFor.turnKey !== turnKey) return;
        setSuggestion((data.suggestion ?? '').trim());
      } catch {
        /* silent by contract */
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();

    return () => controller.abort();
  }, [enabled, turnKey, sessionKey]);

  return { suggestion, dismiss };
}
