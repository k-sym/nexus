/**
 * "File as a to-do" (#477 slice 6a, design D20): a partner attention item
 * becomes a Board session. Pure helpers — the route in routes/attention.ts
 * does the I/O (project lookup, thread insert, partner dismiss).
 */

/** The fields of a partner item the to-do carries. Everything else stays with the partner. */
export interface FiledAttentionItem {
  id: string;
  kind: string;
  title: string;
  why?: string | null;
  body?: string | null;
  links?: { draft_id?: string | null; vault_page?: string | null; proposal_id?: string | null; url?: string | null } | null;
  source?: Record<string, unknown> | null;
}

const KIND_LABELS: Record<string, string> = {
  'mail.waiting': 'waiting mail',
  'mail.urgent': 'urgent mail',
  'draft.pending': 'a pending draft',
  'meeting.prep': 'meeting prep',
  'quiz.prep': 'quiz prep',
  'quiz.harvest': 'a quiz harvest',
  'autonomy.proposal': 'an autonomy proposal',
  'pr.review': 'a PR review',
  'recon.decision': 'a reconciliation decision',
  'brief.morning': 'the morning brief',
  'evening.triage': 'the evening triage',
  'night.summary': 'a night summary',
  'recon.update': 'a reconciliation update',
  'system.alert': 'a system alert',
};

/** Thread title: the item's title, clipped like the other origins. */
export function attentionThreadTitle(item: Pick<FiledAttentionItem, 'title' | 'kind'>): string {
  const title = item.title.trim();
  return (title || `Needs you: ${KIND_LABELS[item.kind] ?? item.kind}`).slice(0, 120);
}

/** What the board stores on the thread: enough to show the origin, nothing the partner owns. */
export function attentionOriginJson(item: Pick<FiledAttentionItem, 'id' | 'kind' | 'title'>): string {
  return JSON.stringify({ id: item.id, kind: item.kind, title: item.title.trim().slice(0, 120) });
}

/**
 * The exact first turn of a to-do session filed from the phone. Same posture as
 * the board's other origins (#439): the source is named, the agent is told how
 * to work it, and no external system is written by the agent.
 */
export function buildAttentionFirstTurn(item: FiledAttentionItem): string {
  const lines: string[] = [];
  const what = KIND_LABELS[item.kind] ?? item.kind;
  lines.push(item.title.trim() || `Needs you: ${what}`);
  if (item.why?.trim()) {
    lines.push('');
    lines.push(item.why.trim());
  }
  // D43: a mail item's body is the partner's first line of the message (the
  // snippet) — hostile input the partner screens before a model sees it, so
  // it never rides into a session's first turn; the conversation is named
  // below instead. Every other kind's body is the producer's own prose.
  const isMail = item.kind.startsWith('mail.');
  if (!isMail && item.body?.trim()) {
    lines.push('');
    lines.push(item.body.trim());
  }
  lines.push('');
  const refs: string[] = [];
  // D43: a mail item names its conversation so the session's agent can read the
  // latest message through the partner (`partner mail thread <account>:<ref>`);
  // the text itself never rides along — the partner screens thread bodies.
  const account = typeof item.source?.account === 'string' ? item.source.account : '';
  const ref = typeof item.source?.ref === 'string' ? item.source.ref : '';
  if (isMail && account && ref) refs.push(`mail conversation ${account}:${ref} (read it with \`partner mail thread ${account}:${ref}\`)`);
  if (item.links?.url) refs.push(`link ${item.links.url}`);
  if (item.links?.vault_page) refs.push(`vault page "${item.links.vault_page}"`);
  if (item.links?.draft_id) refs.push(`draft ${item.links.draft_id}`);
  if (item.links?.proposal_id) refs.push(`autonomy proposal ${item.links.proposal_id}`);
  const accountNote = account ? ` (account ${account})` : '';
  lines.push(`Source: partner attention item ${item.id} — ${what}${accountNote}${refs.length ? `; ${refs.join(', ')}` : ''}. Filed from the phone as a to-do.`);
  lines.push('');
  lines.push('How to work this:');
  lines.push('- Work out what is actually needed and propose the next concrete step before doing anything.');
  lines.push('- Pull the referenced page, draft or thread into the conversation if it helps; ask before assuming.');
  lines.push('- Do not send mail, write to GitHub, Monday or Jira, or change external systems: those are decided by hand after review.');
  return lines.join('\n');
}
