/**
 * Session-first board (#439): draft the real problem out of an Inbox item (a
 * GitHub issue or a Monday item) the way tickets/draft.ts does for Jira.
 *
 * The parsing, project mapping and slug helpers are imported from the ticket
 * module so both flows drift together; this module owns what differs: the
 * input shape, the system prompt (an issue is not a forwarded email chain),
 * the repo-convention branch name and the first-turn trailer. The ticket
 * module itself is untouched.
 */
import { BOARD_BRANCH_TYPES, type BoardBranchType, type OriginDraft } from '@nexus/shared';
import { extractJsonObject, resolveProjectId, slugify, type DraftProject } from '../tickets/draft.js';

export interface OriginDraftInput {
  kind: 'github' | 'monday';
  /** Issue number as text, or the Monday item id. */
  id: string;
  title: string;
  url: string | null;
  /** Issue body, or the Monday item's status and column text. May be empty. */
  body: string;
}

export function isBoardBranchType(value: unknown): value is BoardBranchType {
  return typeof value === 'string' && (BOARD_BRANCH_TYPES as readonly string[]).includes(value);
}

/** The model answers in the ticket vocabulary (`feature`); the repo convention is `feat/`. */
export function normaliseBranchType(value: unknown): BoardBranchType {
  if (value === 'feature') return 'feat';
  return isBoardBranchType(value) ? value : 'fix';
}

/** `fix/<slug>` — AGENTS.md's branch form. A leading `<type>/` in the
 *  description is stripped before rebuilding, so re-drafting is idempotent. */
export function buildBoardBranchName(type: BoardBranchType, description: string): string {
  const desc = description.trim().replace(/^(feat|feature|fix|hotfix)\//i, '');
  return `${type}/${slugify(desc) || 'work'}`;
}

/** Swap the `<type>/` prefix, keeping the rest. Shared with the web and iOS forms. */
export function withBoardBranchType(branchName: string, type: BoardBranchType): string {
  return `${type}/${branchName.replace(/^(feat|feature|fix|hotfix)\//i, '')}`;
}

export function originLabel(input: Pick<OriginDraftInput, 'kind' | 'id' | 'title'>): string {
  return input.kind === 'github' ? `GitHub issue #${input.id}` : `Monday item "${input.title}"`;
}

export const BOARD_DRAFT_SYSTEM_PROMPT = [
  'You turn a work item into a short brief for a software engineer.',
  'The item is a GitHub issue or a Monday.com initiative. Its text may be a quick note,',
  'a long discussion, a checklist, or a status line with little detail.',
  'Extract the real problem or the concrete change wanted. Keep every detail that',
  'identifies it (file names, error text, screens, who is affected); drop the rest.',
  'Reply with one JSON object and nothing else, no code fence, with keys:',
  '  "problem": string — the problem or change, 1 to 4 sentences, first person plural is fine;',
  '  "project": string|null — the id of the project from the list that most likely owns the code, or null;',
  '  "branchType": "feat" | "fix" | "hotfix" — hotfix only when the item says it is urgent or blocking now;',
  '  "branchDescription": string — 2 to 5 lowercase words, hyphen separated, describing the change.',
].join('\n');

export function buildOriginDraftPrompt(input: OriginDraftInput, projects: DraftProject[]): string {
  const lines: string[] = [];
  lines.push(`${originLabel(input)}: ${input.title}`);
  if (input.url) lines.push(input.url);
  lines.push('');
  lines.push(input.kind === 'github' ? 'Issue body:' : 'Item details:');
  lines.push(input.body.trim() || '(no description; use the title)');
  lines.push('');
  lines.push('Projects (id — name — description):');
  if (projects.length === 0) lines.push('(none)');
  for (const p of projects) {
    const desc = (p.description ?? '').trim().replace(/\s+/g, ' ');
    lines.push(`- ${p.id} — ${p.name}${desc ? ` — ${desc.slice(0, 160)}` : ''}`);
  }
  return lines.join('\n');
}

export function parseOriginDraft(
  text: string,
  input: OriginDraftInput,
  projects: DraftProject[],
  model: string,
): OriginDraft | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const problem = typeof obj.problem === 'string' ? obj.problem.trim() : '';
  if (!problem) return null;
  const branchType = normaliseBranchType(obj.branchType);
  const desc = typeof obj.branchDescription === 'string' && obj.branchDescription.trim()
    ? obj.branchDescription
    : input.title;
  return {
    origin: { kind: input.kind, id: input.id },
    problem,
    projectId: resolveProjectId(obj.project, projects),
    branchType,
    branchName: buildBoardBranchName(branchType, desc),
    model,
  };
}

export interface DraftOriginDeps {
  generate: (systemPrompt: string, prompt: string) => Promise<string>;
  model: string;
}

/** Null when the model returned nothing usable; throws on transport failure. */
export async function draftOrigin(
  input: OriginDraftInput,
  projects: DraftProject[],
  deps: DraftOriginDeps,
): Promise<OriginDraft | null> {
  const text = await deps.generate(BOARD_DRAFT_SYSTEM_PROMPT, buildOriginDraftPrompt(input, projects));
  return parseOriginDraft(text, input, projects, deps.model);
}

export interface OriginFirstTurnInput {
  kind: 'github' | 'monday';
  id: string;
  title: string;
  url: string | null;
  problem: string;
  branchName: string;
}

/** The exact first turn of a board session: the edited problem, the origin, and
 *  the fixed trailer. Same shape as the ticket trailer so a session reads the
 *  same whatever it came from; the external system is never written by the agent. */
export function buildOriginFirstTurn(input: OriginFirstTurnInput): string {
  const problem = input.problem.trim();
  const branch = input.branchName.trim();
  const source = input.kind === 'github'
    ? `Source: GitHub issue #${input.id}${input.url ? ` (${input.url})` : ''} — "${input.title}".`
    : `Source: Monday item "${input.title}"${input.url ? ` (${input.url})` : ''}.`;
  const leaveAlone = input.kind === 'github'
    ? '- Do not close, comment on or edit the issue: it is handled by hand after review.'
    : '- Do not write to Monday: the item is updated by hand after review.';
  const lines: string[] = [];
  lines.push(problem);
  lines.push('');
  lines.push(source);
  lines.push('');
  lines.push('How to work this:');
  lines.push(`- Create and work on the branch \`${branch}\` from the current default branch.`);
  lines.push('- Reproduce or locate the cause before changing code, then make the change with a test where the repo has tests.');
  lines.push(`- When the work is done and verified, commit and push \`${branch}\`; do not open a PR or merge.`);
  lines.push(leaveAlone);
  return lines.join('\n');
}
