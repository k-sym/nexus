/**
 * "Show the page" (#477 slice 6a / 8): the vault page behind an item is a memory
 * in the daemon's global namespace, filed by the producer under the exact title
 * in `links.vault_page`. Shared by the phone's route and the glasses gateway so
 * both answer alike. Read-only.
 */
import type { PartnerClient } from '../partner/client.js';
import type { DaemonRecallItem } from '../memory/client.js';

export type PageSearch = (title: string) => Promise<Array<Pick<DaemonRecallItem, 'id' | 'title' | 'body'>>>;

export interface AttentionPageResult {
  status: number;
  body: { title: string; body: string; memory_id?: string; item_id: string } | { error: string };
}

export async function lookupAttentionPage(partner: PartnerClient, search: PageSearch, id: string): Promise<AttentionPageResult> {
  let item: { links?: { vault_page?: string | null } | null } | undefined;
  try {
    item = (await partner.getAttention(id)) as typeof item;
  } catch (err: any) {
    return { status: err?.status === 404 ? 404 : 502, body: { error: extractDetail(err?.message) || 'Attention fetch failed.' } };
  }
  const title = item?.links?.vault_page?.trim();
  if (!title) return { status: 404, body: { error: 'This item has no page.' } };
  let hits: Array<Pick<DaemonRecallItem, 'id' | 'title' | 'body'>>;
  try {
    hits = await search(title);
  } catch (err: any) {
    return { status: 502, body: { error: `Memory daemon unavailable — ${err?.message || 'search failed'}` } };
  }
  const wanted = title.toLowerCase();
  const page = hits.find((h) => (h.title ?? '').trim().toLowerCase() === wanted) ?? null;
  if (!page || !page.body) return { status: 404, body: { error: `No page titled "${title}" in the vault.` } };
  return { status: 200, body: { title: page.title ?? title, body: page.body, memory_id: page.id, item_id: id } };
}

/** The partner answers FastAPI-style `{"detail": "..."}`; surface the sentence. */
export function extractDetail(message?: string): string | undefined {
  if (!message) return undefined;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* not JSON — use as-is */
  }
  return message;
}
