declare global {
  interface Window {
    __NEXUS_API__?: string;
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
  return fetch(apiUrl(input), init);
}
