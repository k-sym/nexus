import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBoardBranchName, withBoardBranchType, normaliseBranchType, buildOriginDraftPrompt,
  parseOriginDraft, draftOrigin, buildOriginFirstTurn, BOARD_DRAFT_SYSTEM_PROMPT,
} from '../board/draft';

const projects = [{ id: 'p-nexus', name: 'Nexus', description: 'Agent OS' }, { id: 'p-wse', name: 'WSE', description: null }];
const issue = { kind: 'github' as const, id: '439', title: 'Session-first Kanban', url: 'https://github.com/k-sym/nexus/issues/439', body: 'The board is stale.' };
const item = { kind: 'monday' as const, id: '987', title: 'Portfolio refresh', url: null, body: 'Status: Planned' };

test('branch names follow the repo convention and re-drafting is idempotent', () => {
  assert.equal(buildBoardBranchName('feat', 'Session First Kanban'), 'feat/session-first-kanban');
  assert.equal(buildBoardBranchName('fix', 'fix/already-prefixed'), 'fix/already-prefixed');
  assert.equal(buildBoardBranchName('hotfix', 'feature/x y'), 'hotfix/x-y');
  assert.equal(buildBoardBranchName('fix', '!!!'), 'fix/work');
  assert.equal(withBoardBranchType('feat/session-first', 'fix'), 'fix/session-first');
  assert.equal(withBoardBranchType('session-first', 'hotfix'), 'hotfix/session-first');
});

test('normaliseBranchType maps the ticket vocabulary and defaults to fix', () => {
  assert.equal(normaliseBranchType('feature'), 'feat');
  assert.equal(normaliseBranchType('feat'), 'feat');
  assert.equal(normaliseBranchType('hotfix'), 'hotfix');
  assert.equal(normaliseBranchType('nonsense'), 'fix');
  assert.equal(normaliseBranchType(undefined), 'fix');
});

test('the prompt names the origin, its body and the project list', () => {
  const prompt = buildOriginDraftPrompt(issue, projects);
  assert.match(prompt, /^GitHub issue #439: Session-first Kanban\nhttps:\/\/github.com\/k-sym\/nexus\/issues\/439\n\nIssue body:\nThe board is stale\./);
  assert.match(prompt, /- p-nexus — Nexus — Agent OS\n- p-wse — WSE$/);
  const mondayPrompt = buildOriginDraftPrompt({ ...item, body: '' }, []);
  assert.match(mondayPrompt, /Monday item "Portfolio refresh": Portfolio refresh\n\nItem details:\n\(no description; use the title\)/);
  assert.match(mondayPrompt, /\(none\)/);
  assert.match(BOARD_DRAFT_SYSTEM_PROMPT, /"feat" \| "fix" \| "hotfix"/);
});

test('parseOriginDraft tolerates fences, maps the project and builds the branch', () => {
  const draft = parseOriginDraft(
    'Sure:\n```json\n{"problem":"Replace tasks with sessions.","project":"Nexus","branchType":"feature","branchDescription":"session first board"}\n```',
    issue, projects, 'claude-code/claude-sonnet-5',
  );
  assert.deepEqual(draft, {
    origin: { kind: 'github', id: '439' },
    problem: 'Replace tasks with sessions.',
    projectId: 'p-nexus',
    branchType: 'feat',
    branchName: 'feat/session-first-board',
    model: 'claude-code/claude-sonnet-5',
  });
  // No description → the title; unknown project → null; no problem → null.
  const fallback = parseOriginDraft('{"problem":"x","project":"Nope","branchType":"fix"}', item, projects, 'm')!;
  assert.equal(fallback.projectId, null);
  assert.equal(fallback.branchName, 'fix/portfolio-refresh');
  assert.equal(parseOriginDraft('{"project":"Nexus"}', issue, projects, 'm'), null);
  assert.equal(parseOriginDraft('no json here', issue, projects, 'm'), null);
});

test('draftOrigin wires the generator with the board system prompt', async () => {
  let seenSystem = '';
  const draft = await draftOrigin(issue, projects, {
    model: 'claude-code/claude-sonnet-5',
    generate: async (system) => { seenSystem = system; return '{"problem":"Do it.","branchType":"hotfix","branchDescription":"now"}'; },
  });
  assert.equal(seenSystem, BOARD_DRAFT_SYSTEM_PROMPT);
  assert.equal(draft?.branchName, 'hotfix/now');
});

test('the first turn carries the problem, the source and the trailer per origin kind', () => {
  const gh = buildOriginFirstTurn({ ...issue, problem: '  Replace tasks with sessions.  ', branchName: ' feat/session-first ' });
  assert.ok(gh.startsWith('Replace tasks with sessions.\n\nSource: GitHub issue #439 (https://github.com/k-sym/nexus/issues/439) — "Session-first Kanban".\n\nHow to work this:'));
  assert.match(gh, /Create and work on the branch `feat\/session-first`/);
  assert.match(gh, /commit and push `feat\/session-first`; do not open a PR or merge\./);
  assert.match(gh, /Do not close, comment on or edit the issue/);
  const md = buildOriginFirstTurn({ ...item, problem: 'Refresh it.', branchName: 'feat/portfolio' });
  assert.match(md, /Source: Monday item "Portfolio refresh"\.\n/);
  assert.match(md, /Do not write to Monday/);
});
