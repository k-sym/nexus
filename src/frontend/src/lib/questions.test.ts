import { describe, expect, it } from 'vitest';
import {
  buildQuestionAnswerSummary,
  normalizeQuestionRequest,
  parseQuestionResult,
  parseTerminalAskBlock,
} from './questions';

const rawRequest = {
  questions: [{
    id: 'scope',
    header: 'Scope',
    question: 'Which scope?',
    options: [
      { value: 'small', label: 'Small', description: 'Minimal change' },
      { value: 'full', label: 'Full', description: 'Complete change' },
    ],
  }],
};

describe('question utilities', () => {
  it('normalizes a valid native request with defaults', () => {
    expect(normalizeQuestionRequest(rawRequest)).toEqual({
      questions: [{ ...rawRequest.questions[0], multiple: false, allowOther: true }],
    });
  });

  it('parses a terminal ask fence and extracts its preamble', () => {
    const parsed = parseTerminalAskBlock(`Choose:\n\`\`\`ask\n${JSON.stringify(rawRequest)}\n\`\`\`  \n`);
    expect(parsed).toEqual({
      preamble: 'Choose:',
      request: normalizeQuestionRequest(rawRequest),
    });
  });

  it('normalizes the advertised legacy ask format for fallback cards', () => {
    const legacyRequest = {
      questions: [{
        header: 'Database',
        question: 'Which DB?',
        multiple: true,
        custom: false,
        options: [
          { label: 'Postgres', description: 'Server database' },
          { label: 'SQLite', description: 'Local file' },
        ],
      }],
    };

    expect(normalizeQuestionRequest(legacyRequest)).toBeNull();
    expect(parseTerminalAskBlock(`Pick one:\n\`\`\`ask\n${JSON.stringify(legacyRequest)}\n\`\`\``)).toEqual({
      preamble: 'Pick one:',
      request: {
        questions: [{
          id: 'question-1',
          header: 'Database',
          question: 'Which DB?',
          multiple: true,
          allowOther: false,
          options: [
            { value: 'option-1', label: 'Postgres', description: 'Server database' },
            { value: 'option-2', label: 'SQLite', description: 'Local file' },
          ],
        }],
      },
    });
  });

  it('rejects malformed, non-terminal, and ordinary Markdown questions', () => {
    expect(parseTerminalAskBlock('```ask\n{broken}\n```')).toBeNull();
    expect(parseTerminalAskBlock(`\`\`\`ask\n${JSON.stringify(rawRequest)}\n\`\`\`\nAfterward`)).toBeNull();
    expect(parseTerminalAskBlock('A. One\nB. Two')).toBeNull();
  });

  it('parses answered and cancelled tool results', () => {
    const answered = {
      status: 'answered',
      toolCallId: 'call-1',
      answers: [{ questionId: 'scope', selected: ['small'] }],
    };
    expect(parseQuestionResult(answered)).toEqual(answered);
    expect(parseQuestionResult(JSON.stringify(answered))).toEqual(answered);
    expect(parseQuestionResult('Scope: Small\n\n{"toolCallId":"call-1","answers":[{"questionId":"scope","selected":["small"]}]}'))
      .toEqual(answered);
    expect(parseQuestionResult({ status: 'cancelled', toolCallId: 'call-1', error: 'Aborted' }))
      .toEqual({ status: 'cancelled', toolCallId: 'call-1', error: 'Aborted' });
    expect(parseQuestionResult({ status: 'answered', answers: [] })).toBeNull();
  });

  it('builds deterministic summaries from labels and custom text', () => {
    const request = normalizeQuestionRequest(rawRequest)!;
    expect(buildQuestionAnswerSummary(request, [{
      questionId: 'scope',
      selected: ['small'],
      custom: 'With tests',
    }])).toBe('Scope: Small, With tests');
  });
});
