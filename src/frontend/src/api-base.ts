declare global {
  interface Window {
    __NEXUS_API__?: string;
    /** Bearer token for a token-gated backend, injected by the desktop shell.
     *  Undefined ⇒ backend is dev-open; no Authorization header is sent. */
    __NEXUS_TOKEN__?: string;
  }
}

function apiBase(): string | undefined {
  const base = window.__NEXUS_API__?.replace(/\/+$/, '');
  return base || undefined;
}

export function apiUrl(url: string): string {
  if (!url.startsWith('/api')) return url;
  const base = apiBase();
  if (!base) return url;
  return `${base}${url.slice('/api'.length)}`;
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = window.__NEXUS_TOKEN__;
  if (!token) return fetch(apiUrl(input), init);
  // Attach the bearer for the token-gated backend, without clobbering an
  // Authorization header a caller set explicitly. `new Headers` normalizes the
  // Headers | record | array forms RequestInit.headers can take.
  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(apiUrl(input), { ...init, headers });
}
