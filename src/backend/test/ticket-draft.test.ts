import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBranchName,
  buildDraftPrompt,
  buildFirstTurn,
  draftTicket,
  draftTicketRaw,
  extractJsonObject,
  parseDraft,
  resolveProjectId,
  slugify,
} from '../tickets/draft';

const projects = [
  { id: 'p-wse', name: 'WSE', description: 'Workplace Safety Essentials — PHP API and reports' },
  { id: 'p-nexus', name: 'Nexus', description: '' },
];
const input = { key: 'SUP-123', summary: 'Scoring wrong on reports', url: 'https://x.atlassian.net/browse/SUP-123', body: 'Hi Ian, last few reports coming across as 8AOFI (the last score isn’t showing). Thanks Paul' };

test('branch names follow fix/SUP123-lowercase-hyphenated', () => {
  assert.equal(buildBranchName('fix', 'SUP-123', 'Scoring last score missing'), 'fix/SUP123-scoring-last-score-missing');
  assert.equal(buildBranchName('hotfix', 'sup-7', 'fix/SUP7-already-prefixed'), 'hotfix/SUP7-already-prefixed');
  assert.equal(buildBranchName('feature', 'SUP-9', '  '), 'feature/SUP9-ticket');
  assert.equal(slugify('A  very--odd__name!!'), 'a-very-odd-name');
  assert.ok(slugify('word '.repeat(30)).length <= 48);
});

test('extractJsonObject tolerates fences and prose', () => {
  assert.deepEqual(extractJsonObject('Sure:\n```json\n{"a": 1, "b": "x}y"}\n```\nthanks'), { a: 1, b: 'x}y' });
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject('{"broken": '), null);
});

test('resolveProjectId accepts id or name, case-insensitive', () => {
  assert.equal(resolveProjectId('p-wse', projects), 'p-wse');
  assert.equal(resolveProjectId('wse', projects), 'p-wse');
  assert.equal(resolveProjectId('Unknown', projects), null);
  assert.equal(resolveProjectId(null, projects), null);
});

test('parseDraft builds a full draft, defaulting type to fix and falling back to the summary', () => {
  const full = parseDraft(
    '{"problem":"Reports render as 8AOFI; the last score is missing.","project":"WSE","branchType":"hotfix","branchDescription":"report last score missing"}',
    input, projects, 'claude-code/claude-sonnet-5',
  );
  assert.deepEqual(full, {
    key: 'SUP-123',
    problem: 'Reports render as 8AOFI; the last score is missing.',
    projectId: 'p-wse',
    branchType: 'hotfix',
    branchName: 'hotfix/SUP123-report-last-score-missing',
    model: 'claude-code/claude-sonnet-5',
  });
  const sparse = parseDraft('{"problem":"x","branchType":"nonsense"}', input, projects, 'm');
  assert.equal(sparse?.branchType, 'fix');
  assert.equal(sparse?.projectId, null);
  assert.equal(sparse?.branchName, 'fix/SUP123-scoring-wrong-on-reports');
  assert.equal(parseDraft('{"problem":""}', input, projects, 'm'), null);
});

test('draftTicket sends the ticket and project list and parses the reply', async () => {
  let seen = '';
  const draft = await draftTicket(input, projects, {
    model: 'claude-code/claude-sonnet-5',
    generate: async (system, prompt) => {
      seen = prompt;
      assert.match(system, /JSON object/);
      return '{"problem":"The last score is missing from recent reports (8AOFI).","project":"p-wse","branchType":"fix","branchDescription":"last score missing"}';
    },
  });
  assert.match(seen, /Ticket SUP-123: Scoring wrong on reports/);
  assert.match(seen, /8AOFI/);
  assert.match(seen, /p-wse — WSE — Workplace Safety/);
  assert.equal(draft?.branchName, 'fix/SUP123-last-score-missing');
  assert.equal(draft?.projectId, 'p-wse');
});

test('buildDraftPrompt notes an empty body instead of sending nothing', () => {
  const prompt = buildDraftPrompt({ ...input, body: '' }, []);
  assert.match(prompt, /\(no description; use the summary\)/);
  assert.match(prompt, /\(none\)/);
});

test('buildFirstTurn carries the problem, the ticket, the branch and the trailer', () => {
  const turn = buildFirstTurn({ key: 'SUP-123', url: input.url, summary: input.summary, problem: '  Fix the last score.  ', branchName: 'fix/SUP123-last-score' });
  assert.ok(turn.startsWith('Fix the last score.\n'));
  assert.match(turn, /Jira ticket SUP-123 \(https:\/\/x\.atlassian\.net\/browse\/SUP-123\)/);
  assert.match(turn, /branch `fix\/SUP123-last-score`/);
  assert.match(turn, /push `fix\/SUP123-last-score`/);
  assert.match(turn, /Do not touch Jira/);
});

// Regression (#432): one in four SUP-1317 drafts came back fenced with a
// trailing comma before the closing brace; JSON.parse rejected it and the
// route answered 502 "nothing usable".
test('extractJsonObject tolerates a trailing comma in a fenced reply', () => {
  const reply = '```json\n{\n  "problem": "Export download fails for TBT.",\n  "project": "p-wse",\n  "branchType": "fix",\n  "branchDescription": "tbt-download-export",\n}\n```';
  assert.deepEqual(extractJsonObject(reply), {
    problem: 'Export download fails for TBT.',
    project: 'p-wse',
    branchType: 'fix',
    branchDescription: 'tbt-download-export',
  });
});

test('extractJsonObject tolerates a trailing comma inside a nested array and leaves strings alone', () => {
  const reply = '{"problem": "x, }", "tags": ["a", "b",], "branchDescription": "y",}';
  assert.deepEqual(extractJsonObject(reply), { problem: 'x, }', tags: ['a', 'b'], branchDescription: 'y' });
});

test('draftTicketRaw returns the raw model text alongside a null draft', async () => {
  const result = await draftTicketRaw(input, projects, { model: 'm', generate: async () => 'I cannot help with that.' });
  assert.equal(result.draft, null);
  assert.equal(result.text, 'I cannot help with that.');
});
