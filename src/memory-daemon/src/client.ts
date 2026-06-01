// Typed HTTP client for the daemon. Used by the MCP stdio shim and (later) the Nexus backend
// so there is a single writer/owner of the index — clients only speak HTTP to :4100.
import type { DaemonConfig } from "./config.js";
import type { RecallResponse, ScopeFilter } from "./retrieval/types.js";

export interface StoreInput {
  namespace: string;
  project?: string | null;
  category?: string | null;
  source: string;
  title?: string;
  body: string;
}

export class MemoryClient {
  constructor(private baseUrl: string) {}

  static fromConfig(cfg: DaemonConfig): MemoryClient {
    return new MemoryClient(`http://${cfg.host}:${cfg.port}`);
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  private qs(params: Record<string, unknown>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.set(k, String(v));
    const s = sp.toString();
    return s ? `?${s}` : "";
  }

  store(input: StoreInput): Promise<{ id: string; action: string }> {
    return this.req("POST", "/memories", input);
  }

  recall(query: string, filter: ScopeFilter = {}, limit?: number): Promise<RecallResponse & { context: string }> {
    return this.req("POST", "/recall", { query, ...filter, limit });
  }

  search(query: string, filter: ScopeFilter = {}, limit?: number): Promise<RecallResponse> {
    return this.req("GET", `/memories${this.qs({ q: query, ...filter, limit })}`);
  }

  list(filter: ScopeFilter = {}, limit?: number): Promise<{ items: unknown[] }> {
    return this.req("GET", `/memories${this.qs({ ...filter, limit })}`);
  }

  get(id: string): Promise<unknown> {
    return this.req("GET", `/memories/${encodeURIComponent(id)}`);
  }

  remove(id: string): Promise<{ id: string; deleted: boolean }> {
    return this.req("DELETE", `/memories/${encodeURIComponent(id)}`);
  }

  health(): Promise<unknown> {
    return this.req("GET", "/health");
  }
}
