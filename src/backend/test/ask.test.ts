import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAskBlock, buildAnswerSummary } from '../chat/ask';
import type { Ask } from '@nexus/shared';

const VALID = [
  'Pick a database for the project.',
  '',
  '```ask',
  '{ "questions": [ { "header": "Database", "question": "Which DB?",',
  '  "options": [ {"label":"Postgres","description":"server"}, {"label":"SQLite","description":"file"} ] } ] }',
  '```',
].join('\n');

test('parseAskBlock extracts preamble + normalized ask', () => {
  const parsed = parseAskBlock(VALID);
  assert.ok(parsed);
  assert.equal(parsed!.preamble, 'Pick a database for the project.');
  assert.equal(parsed!.ask.questions.length, 1);
  const q = parsed!.ask.questions[0];
  assert.equal(q.header, 'Database');
  assert.equal(q.options.length, 2);
  assert.equal(q.multiple, false); // default
  assert.equal(q.custom, true);    // default
});

test('parseAskBlock preserves multiple + custom flags', () => {
  const src = '```ask\n{"questions":[{"header":"H","question":"Q","multiple":true,"custom":false,"options":[{"label":"A","description":""}]}]}\n```';
  const parsed = parseAskBlock(src);
  assert.ok(parsed);
  assert.equal(parsed!.ask.questions[0].multiple, true);
  assert.equal(parsed!.ask.questions[0].custom, false);
});

test('parseAskBlock returns null for malformed JSON', () => {
  const src = 'text\n```ask\n{ not json }\n```';
  assert.equal(parseAskBlock(src), null);
});

test('parseAskBlock returns null when no block present', () => {
  assert.equal(parseAskBlock('just a normal reply'), null);
});

test('parseAskBlock accepts <ask_user> fallback', () => {
  const src = 'hi <ask_user>{"questions":[{"header":"H","question":"Q","options":[{"label":"A","description":"d"}]}]}</ask_user>';
  const parsed = parseAskBlock(src);
  assert.ok(parsed);
  assert.equal(parsed!.preamble, 'hi');
  assert.equal(parsed!.ask.questions[0].options[0].label, 'A');
});

test('parseAskBlock returns null when a question has no options', () => {
  const src = '```ask\n{"questions":[{"header":"H","question":"Q","options":[]}]}\n```';
  assert.equal(parseAskBlock(src), null);
});

test('buildAnswerSummary joins questions with selected + custom', () => {
  const ask: Ask = { questions: [
    { header: 'DB', question: 'Which DB?', options: [], multiple: false, custom: true },
    { header: 'Lang', question: 'Which language?', options: [], multiple: true, custom: true },
  ] };
  const summary = buildAnswerSummary(ask, [
    { header: 'DB', selected: ['Postgres'] },
    { header: 'Lang', selected: ['TS', 'Go'], custom: 'Rust' },
  ]);
  assert.match(summary, /"Which DB\?"="Postgres"/);
  assert.match(summary, /"Which language\?"="TS, Go, Rust"/);
  assert.match(summary, /^User has answered your questions:/);
});

test('buildAnswerSummary marks missing replies as Unanswered', () => {
  const ask: Ask = { questions: [{ header: 'H', question: 'Q', options: [], multiple: false, custom: true }] };
  const summary = buildAnswerSummary(ask, []);
  assert.match(summary, /"Q"="Unanswered"/);
});
