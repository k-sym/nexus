export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiple: boolean;
  allowOther: boolean;
}

export interface QuestionRequest {
  questions: Question[];
}

export interface QuestionAnswer {
  questionId: string;
  selected: string[];
  custom?: string;
}

export type QuestionToolResult =
  | { status: 'answered'; toolCallId: string; answers: QuestionAnswer[] }
  | { status: 'cancelled'; toolCallId: string; error: string };

export interface ParsedAskBlock {
  preamble: string;
  request: QuestionRequest;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeQuestionRequest(value: unknown): QuestionRequest | null {
  const input = record(value);
  if (!input || !Array.isArray(input.questions) || input.questions.length === 0) return null;
  const ids = new Set<string>();
  const questions: Question[] = [];
  for (const value of input.questions) {
    const raw = record(value);
    const id = text(raw?.id);
    const header = text(raw?.header);
    const question = text(raw?.question);
    if (!raw || !id || !header || !question || ids.has(id)) return null;
    if (raw.multiple !== undefined && typeof raw.multiple !== 'boolean') return null;
    if (raw.allowOther !== undefined && typeof raw.allowOther !== 'boolean') return null;
    if (!Array.isArray(raw.options) || raw.options.length < 2) return null;
    ids.add(id);
    const values = new Set<string>();
    const options: QuestionOption[] = [];
    for (const value of raw.options) {
      const option = record(value);
      const optionValue = text(option?.value);
      const label = text(option?.label);
      if (!option || !optionValue || !label || values.has(optionValue)) return null;
      if (option.description !== undefined && typeof option.description !== 'string') return null;
      values.add(optionValue);
      const description = text(option.description);
      options.push({ value: optionValue, label, ...(description ? { description } : {}) });
    }
    questions.push({
      id,
      header,
      question,
      options,
      multiple: raw.multiple ?? false,
      allowOther: raw.allowOther ?? true,
    });
  }
  return { questions };
}

function normalizeLegacyAskRequest(value: unknown): QuestionRequest | null {
  const input = record(value);
  if (!input || !Array.isArray(input.questions)) return null;
  const questions = input.questions.map((value, questionIndex) => {
    const raw = record(value);
    if (!raw) return value;
    const options = Array.isArray(raw.options)
      ? raw.options.map((value, optionIndex) => {
        const option = record(value);
        if (!option || Object.hasOwn(option, 'value')) return value;
        return { ...option, value: `option-${optionIndex + 1}` };
      })
      : raw.options;
    return {
      ...raw,
      ...(Object.hasOwn(raw, 'id') ? {} : { id: `question-${questionIndex + 1}` }),
      ...(Object.hasOwn(raw, 'allowOther') || !Object.hasOwn(raw, 'custom')
        ? {}
        : { allowOther: raw.custom }),
      options,
    };
  });
  return normalizeQuestionRequest({ questions });
}

export function parseTerminalAskBlock(value: string): ParsedAskBlock | null {
  const match = /(?:^|\n)[ \t]*```ask[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(value.trimEnd());
  if (!match || match.index === undefined) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const request = normalizeQuestionRequest(parsed) ?? normalizeLegacyAskRequest(parsed);
    if (!request) return null;
    return { preamble: value.slice(0, match.index).trim(), request };
  } catch {
    return null;
  }
}

export function parseQuestionResult(value: unknown): QuestionToolResult | null {
  let candidate = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    const separator = trimmed.lastIndexOf('\n\n');
    const json = (separator >= 0 ? trimmed.slice(separator + 2) : trimmed).trim();
    try {
      candidate = JSON.parse(json);
    } catch {
      return null;
    }
  }
  const result = record(candidate);
  const toolCallId = text(result?.toolCallId);
  if (!result || !toolCallId) return null;
  if (result.status === 'cancelled' || result.cancelled === true) {
    const error = text(result.error);
    return error ? { status: 'cancelled', toolCallId, error } : null;
  }
  if ((result.status !== 'answered' && result.status !== undefined) || !Array.isArray(result.answers)) return null;
  const answers: QuestionAnswer[] = [];
  for (const value of result.answers) {
    const answer = record(value);
    const questionId = text(answer?.questionId);
    if (!answer || !questionId || !Array.isArray(answer.selected) || answer.selected.some((item) => typeof item !== 'string')) return null;
    const custom = text(answer.custom);
    answers.push({ questionId, selected: answer.selected as string[], ...(custom ? { custom } : {}) });
  }
  return { status: 'answered', toolCallId, answers };
}

export function buildQuestionAnswerSummary(request: QuestionRequest, answers: QuestionAnswer[]): string {
  return request.questions.map((question) => {
    const answer = answers.find((item) => item.questionId === question.id);
    const labels = (answer?.selected ?? []).map((selected) =>
      question.options.find((option) => option.value === selected)?.label ?? selected);
    if (answer?.custom) labels.push(answer.custom);
    return `${question.header}: ${labels.join(', ')}`;
  }).join('\n');
}
