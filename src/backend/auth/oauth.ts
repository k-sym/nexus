/**
 * OAuth flows for AI providers.
 *
 * Delegates to @earendil-works/pi-ai's loginAnthropic / loginOpenAICodex for
 * the actual token exchanges (PKCE, originator headers, etc.). Manages
 * loopback cancellation and re-entrancy — same pattern as zosma-cowork's
 * start_oauth command but in-process.
 */
import { EventEmitter } from 'events';
import type { OAuthCredentials } from '@earendil-works/pi-ai/oauth';
import { setCredential, type Credential } from './store';

export interface OAuthResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  account_id?: string;
}

export type OAuthEvent =
  | { kind: 'auth_url'; url: string; instructions?: string }
  | { kind: 'progress'; message: string }
  | { kind: 'complete'; account_id?: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string };

let inflight: {
  providerId: string;
  abort: AbortController;
  emitter: EventEmitter;
  promise: Promise<OAuthResult>;
} | null = null;

/** Provider ids that support OAuth. */
const SUPPORTED_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot']);

export function isProviderOAuthSupported(providerId: string): boolean {
  return SUPPORTED_PROVIDERS.has(providerId);
}

export async function isProviderLoggedIn(providerId: string): Promise<boolean> {
  const { getCredential } = await import('./store');
  const cred = getCredential(providerId);
  return cred?.type === 'oauth';
}

async function runAnthropicFlow(
  emitter: EventEmitter,
  signal: AbortSignal,
): Promise<OAuthResult> {
  const { loginAnthropic } = await import('@earendil-works/pi-ai/oauth');
  const callbacks = {
    onAuth: (info: { url: string; instructions?: string }) => {
      emitter.emit('event', { kind: 'auth_url', url: info.url, instructions: info.instructions } as OAuthEvent);
    },
    onPrompt: async (prompt: { message: string; placeholder?: string }) => {
      // The desktop UI has no input surface for interactive prompts. Reject
      // with AbortError so the loopback server can be torn down cleanly.
      // (zosma-cowork: throws with the same shape.)
      throw new Error(`Interactive prompts are not supported in the desktop OAuth flow (message: ${String(prompt.message ?? '')})`);
    },
    onProgress: (message: string) => {
      emitter.emit('event', { kind: 'progress', message } as OAuthEvent);
    },
    onManualCodeInput: () =>
      new Promise<string>((_resolve, reject) => {
        const err = new Error('OAuth cancelled');
        err.name = 'AbortError';
        if (signal.aborted) {
          reject(err);
          return;
        }
        const onAbort = () => reject(err);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    signal,
  };

  const creds: OAuthCredentials = await loginAnthropic(callbacks);
  const credential: Credential = {
    type: 'oauth',
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    ...(creds as Record<string, unknown>),
  };
  setCredential('anthropic', credential);
  return { ok: true };
}

async function runOpenAICodexFlow(
  emitter: EventEmitter,
  signal: AbortSignal,
): Promise<OAuthResult> {
  const { loginOpenAICodex } = await import('@earendil-works/pi-ai/oauth');
  const creds: OAuthCredentials = await loginOpenAICodex({
    originator: 'codex_cli_rs',
    onAuth: (info) => {
      emitter.emit('event', { kind: 'auth_url', url: info.url, instructions: info.instructions } as OAuthEvent);
    },
    onPrompt: async (prompt) => {
      throw new Error(`Interactive prompts are not supported in the desktop OAuth flow (message: ${String(prompt.message ?? '')})`);
    },
    onProgress: (message) => {
      emitter.emit('event', { kind: 'progress', message } as OAuthEvent);
    },
    onManualCodeInput: () =>
      new Promise<string>((_resolve, reject) => {
        const err = new Error('OAuth cancelled');
        err.name = 'AbortError';
        if (signal.aborted) {
          reject(err);
          return;
        }
        signal.addEventListener('abort', () => reject(err), { once: true });
      }),
  });
  const credential: Credential = {
    type: 'oauth',
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    ...(creds as Record<string, unknown>),
  };
  setCredential('openai-codex', credential);
  return { ok: true };
}

/**
 * Start an OAuth flow for a provider. Returns the emitter (for streaming
 * progress events to the client) and a promise that resolves when the flow
 * completes. Cancelling via cancelOAuth() aborts the flow and cleans up.
 */
export function startOAuth(
  providerId: string,
  onEvent: (ev: OAuthEvent) => void,
): { ok: boolean; reason?: string } {
  if (!isProviderOAuthSupported(providerId)) {
    return { ok: false, reason: 'unsupported' };
  }

  // Cancel any in-flight flow before starting a new one (re-entrant safety).
  if (inflight) {
    inflight.abort.abort();
  }

  const ac = new AbortController();
  const emitter = new EventEmitter();
  emitter.on('event', onEvent);

  const promise = (async (): Promise<OAuthResult> => {
    try {
      let result: OAuthResult;
      if (providerId === 'anthropic') {
        result = await runAnthropicFlow(emitter, ac.signal);
      } else if (providerId === 'openai-codex') {
        result = await runOpenAICodexFlow(emitter, ac.signal);
      } else {
        result = { ok: false, error: `Unsupported provider: ${providerId}` };
      }

      if (ac.signal.aborted) {
        emitter.emit('event', { kind: 'cancelled' } as OAuthEvent);
        return { ok: false, cancelled: true };
      }

      if (result.ok) {
        emitter.emit('event', { kind: 'complete', account_id: result.account_id } as OAuthEvent);
      } else {
        emitter.emit('event', { kind: 'error', error: result.error || 'unknown error' } as OAuthEvent);
      }
      return result;
    } catch (err: unknown) {
      const errAny = err as { name?: string; message?: string } | undefined;
      const cancelled = errAny?.name === 'AbortError' || ac.signal.aborted;
      if (cancelled) {
        emitter.emit('event', { kind: 'cancelled' } as OAuthEvent);
        return { ok: false, cancelled: true };
      }
      const errorMsg = String(errAny?.message ?? err);
      emitter.emit('event', { kind: 'error', error: errorMsg } as OAuthEvent);
      return { ok: false, error: errorMsg };
    } finally {
      emitter.removeAllListeners('event');
    }
  })();

  inflight = { providerId, abort: ac, emitter, promise };
  return { ok: true };
}

export function cancelOAuth(): { ok: boolean } {
  if (!inflight) return { ok: false };
  inflight.abort.abort();
  return { ok: true };
}

export function getInflightProvider(): string | null {
  return inflight?.providerId ?? null;
}

/**
 * Refresh an OAuth token if it's expired or about to expire.
 * Returns true if a refresh was needed and succeeded.
 */
export async function refreshIfNeeded(providerId: string): Promise<boolean> {
  const { getCredential } = await import('./store');
  const { refreshAnthropicToken, refreshOpenAICodexToken } = await import('@earendil-works/pi-ai/oauth');
  const cred = getCredential(providerId);
  if (!cred || cred.type !== 'oauth') return false;

  const FIVE_MIN = 5 * 60 * 1000;
  if (cred.expires > Date.now() + FIVE_MIN) return false;

  try {
    let refreshed: OAuthCredentials | null = null;
    if (providerId === 'anthropic') {
      refreshed = await refreshAnthropicToken(cred.refresh);
    } else if (providerId === 'openai-codex') {
      refreshed = await refreshOpenAICodexToken(cred.refresh);
    }
    if (refreshed) {
      setCredential(providerId, {
        type: 'oauth',
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        ...(refreshed as Record<string, unknown>),
      });
      return true;
    }
  } catch (err) {
    console.error(`[auth] refresh failed for ${providerId}:`, err);
  }
  return false;
}
