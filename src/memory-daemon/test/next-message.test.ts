import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestion } from '../src/routes/operations';

test('keeps a clean suggestion untouched', () => {
  assert.equal(cleanSuggestion('run the tests'), 'run the tests');
});

test('strips wrapping quotes and label preamble', () => {
  assert.equal(cleanSuggestion('"run the tests"'), 'run the tests');
  assert.equal(cleanSuggestion('Next message: run the tests'), 'run the tests');
  assert.equal(cleanSuggestion('User: run the tests'), 'run the tests');
  assert.equal(cleanSuggestion('Suggestion: "run the tests"'), 'run the tests');
});

test('keeps only the first non-empty line', () => {
  assert.equal(cleanSuggestion('\n\nrun the tests\nthen deploy'), 'run the tests');
});

test('preserves a trailing question mark but drops stray punctuation', () => {
  assert.equal(cleanSuggestion('what broke?'), 'what broke?');
  assert.equal(cleanSuggestion('run the tests.'), 'run the tests');
  assert.equal(cleanSuggestion('run the tests ...'), 'run the tests');
});

test('caps length at 160 chars', () => {
  assert.equal(cleanSuggestion('x'.repeat(300)).length, 160);
});

test('returns empty string for empty or decoration-only output', () => {
  assert.equal(cleanSuggestion(''), '');
  assert.equal(cleanSuggestion('   \n  '), '');
  assert.equal(cleanSuggestion('""'), '');
});
