/**
 * Ticket to session (#432): draft the real problem out of a Jira ticket.
 *
 * Pure pieces (prompt build, output parse, branch normalisation, first-turn
 * composition) are exported for tests; `draftTicket` wires them to an
 * injectable generator so nothing here spawns the CLI under test.
 */
import { TICKET_BRANCH_TYPES, type TicketBranchType, type TicketDraft } from '@nexus/shared';

export interface DraftProject {
  id: string;
  name: string;
  description?: string | null;
}

export interface DraftTicketInput {
  key: string;
  summary: string;
  url: string | null;
  /** Cleaned description body (content rules already applied). May be empty. */
  body: string;
}

/** `SUP-123` → `SUP123`: SSUK branch names drop the hyphen from the key. */
export function branchKey(ticketKey: string): string {
  return ticketKey.replace(/-/g, '').toUpperCase();
}

/** Lowercase, hyphenated, no leading/trailing hyphens, bounded length. */
export function slugify(text: string, max = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 16 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

export function isBranchType(value: unknown): value is TicketBranchType {
  return typeof value === 'string' && (TICKET_BRANCH_TYPES as readonly string[]).includes(value);
}

/** `fix/SUP123-scoring-last-score-missing`. `description` may already carry a
 *  type prefix or the key; both are stripped before rebuilding. */
export function buildBranchName(type: TicketBranchType, ticketKey: string, description: string): string {
  const key = branchKey(ticketKey);
  let desc = description.trim();
  desc = desc.replace(/^(fix|hotfix|feature)\//i, '');
  desc = desc.replace(new RegExp(`^${key}-?`, 'i'), '');
  desc = desc.replace(new RegExp(`^${ticketKey}-?`, 'i'), '');
  const slug = slugify(desc) || 'ticket';
  return `${type}/${key}-${slug}`;
}

export const DRAFT_SYSTEM_PROMPT = [
  'You turn a support ticket into a short brief for a software engineer.',
  'The ticket text is usually a forwarded email chain: quoted replies, signatures,',
  'disclaimers and pleasantries wrapped around one or two sentences of real problem.',
  'Extract the real problem. Keep every concrete detail that identifies it (codes,',
  'report names, screens, error text, who is affected); drop everything else.',
  'Reply with one JSON object and nothing else, no code fence, with keys:',
  '  "problem": string — the problem statement, first person plural is fine, 1 to 4 sentences;',
  '  "project": string|null — the id of the project from the list that most likely owns the code, or null;',
  '  "branchType": "fix" | "hotfix" | "feature" — hotfix only when the ticket says it is urgent or blocking clients now;',
  '  "branchDescription": string — 2 to 5 lowercase words, hyphen separated, describing the problem.',
].join('\n');

export function buildDraftPrompt(input: DraftTicketInput, projects: DraftProject[]): string {
  const lines: string[] = [];
  lines.push(`Ticket ${input.key}: ${input.summary}`);
  lines.push('');
  lines.push('Ticket body:');
  lines.push(input.body.trim() || '(no description; use the summary)');
  lines.push('');
  lines.push('Projects (id — name — description):');
  if (projects.length === 0) lines.push('(none)');
  for (const p of projects) {
    const desc = (p.description ?? '').trim().replace(/\s+/g, ' ');
    lines.push(`- ${p.id} — ${p.name}${desc ? ` — ${desc.slice(0, 160)}` : ''}`);
  }
  return lines.join('\n');
}

/** Find the first balanced `{ … }` in model output; tolerates fences and prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(stripped.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Map the model's project pick (id or name, any case) to a known project id. */
export function resolveProjectId(pick: unknown, projects: DraftProject[]): string | null {
  if (typeof pick !== 'string' || !pick.trim()) return null;
  const needle = pick.trim().toLowerCase();
  const hit = projects.find((p) => p.id.toLowerCase() === needle)
    ?? projects.find((p) => p.name.toLowerCase() === needle);
  return hit?.id ?? null;
}

export function parseDraft(
  text: string,
  input: DraftTicketInput,
  projects: DraftProject[],
  model: string,
): TicketDraft | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const problem = typeof obj.problem === 'string' ? obj.problem.trim() : '';
  if (!problem) return null;
  const branchType: TicketBranchType = isBranchType(obj.branchType) ? obj.branchType : 'fix';
  const desc = typeof obj.branchDescription === 'string' && obj.branchDescription.trim()
    ? obj.branchDescription
    : input.summary;
  return {
    key: input.key,
    problem,
    projectId: resolveProjectId(obj.project, projects),
    branchType,
    branchName: buildBranchName(branchType, input.key, desc),
    model,
  };
}

export interface DraftTicketDeps {
  generate: (systemPrompt: string, prompt: string) => Promise<string>;
  model: string;
}

/** Null when the model returned nothing usable; throws on transport failure. */
export async function draftTicket(
  input: DraftTicketInput,
  projects: DraftProject[],
  deps: DraftTicketDeps,
): Promise<TicketDraft | null> {
  const text = await deps.generate(DRAFT_SYSTEM_PROMPT, buildDraftPrompt(input, projects));
  return parseDraft(text, input, projects, deps.model);
}

export interface FirstTurnInput {
  key: string;
  url: string | null;
  summary: string;
  problem: string;
  branchName: string;
}

/** The exact first turn of a ticket session: the edited problem, then the fixed
 *  trailer every ticket session gets. Composed here so web, iOS and tests share
 *  one copy. */
export function buildFirstTurn(input: FirstTurnInput): string {
  const problem = input.problem.trim();
  const branch = input.branchName.trim();
  const lines: string[] = [];
  lines.push(problem);
  lines.push('');
  lines.push(`Source: Jira ticket ${input.key}${input.url ? ` (${input.url})` : ''} — "${input.summary}".`);
  lines.push('');
  lines.push('How to work this:');
  lines.push(`- Create and work on the branch \`${branch}\` from the current default branch.`);
  lines.push('- Reproduce or locate the cause before changing code, then fix it with a test where the repo has tests.');
  lines.push(`- When the fix is done and verified, commit and push \`${branch}\`; do not open a PR or merge.`);
  lines.push('- Do not touch Jira: the ticket is closed by hand after review.');
  return lines.join('\n');
}
