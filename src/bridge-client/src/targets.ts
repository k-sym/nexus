import type { ClientConfig } from './config.js';
import { identifier } from './protocol.js';
export interface Target { id: string; name: string; updatedAt: string }
export interface Targets { instanceId: string; enabled: boolean; mode: string; maxMessageBytes: number; projects: Array<Target & { threads: Target[] }> }
export async function discover(config: ClientConfig, signal?: AbortSignal): Promise<Targets> {
  let response: Response;
  try {
    response = await fetch(`${config.backend_url}/api/agent-bridge/targets`, { redirect: 'error',
      headers: config.backend_token ? { Authorization: `Bearer ${config.backend_token}` } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  } catch { throw new Error('Could not reach the Nexus targets endpoint; check backend URL and connectivity.'); }
  if (!response.ok) throw new Error(`Nexus target lookup failed (HTTP ${response.status}); check backend access and credentials.`);
  let data: Targets;
  try {
    // Bound discovery responses before parsing, including chunked responses.
    const reader = response.body!.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2_000_000) throw new Error(); chunks.push(value); } }
    finally { await reader.cancel(); }
    data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || data.instanceId !== config.instance_id || typeof data.enabled !== 'boolean' || !['notify_only', 'queue_for_approval'].includes(data.mode) ||
      !Number.isInteger(data.maxMessageBytes) || data.maxMessageBytes < 1 || data.maxMessageBytes > 1048576 || !Array.isArray(data.projects)) throw new Error();
    for (const project of data.projects) {
      identifier(project.id); if (typeof project.name !== 'string' || !Array.isArray(project.threads)) throw new Error();
      for (const thread of project.threads) { identifier(thread.id); if (typeof thread.name !== 'string') throw new Error(); }
    }
  } catch { throw new Error('Invalid target response or instance mismatch; check the configured Nexus instance.'); }
  if (!data.enabled) throw new Error('Agent Bridge is disabled in Nexus.');
  return data;
}
function choose<T extends Target>(items: T[], query: string, label: string): T {
  const byId = items.find(item => item.id === query);
  if (byId) return byId;
  const matches = items.filter(item => item.name === query);
  if (matches.length === 1) return matches[0];
  const candidates = (matches.length ? matches : items).map(item => `${JSON.stringify(item.name)} (${item.id})`).join(', ');
  throw new Error(`${label} is missing or ambiguous. Candidates: ${candidates || 'none; check project/thread scope in Nexus'}`);
}
export function resolveTarget(targets: Targets, projectQuery: string, threadQuery: string) {
  const project = choose(targets.projects, projectQuery, 'Project');
  const thread = choose(project.threads, threadQuery, 'Thread');
  return { instanceId: targets.instanceId, projectId: project.id, threadId: thread.id };
}
