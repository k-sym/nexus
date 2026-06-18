export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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

export interface QuestionAnswerSubmission {
  answers: QuestionAnswer[];
}

export type QuestionToolResult =
  | { status: 'answered'; toolCallId: string; answers: QuestionAnswer[] }
  | { status: 'cancelled'; toolCallId: string; error: string };

export type QuestionAnswerResponse =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, field: string): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `${field} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

export function normalizeQuestionRequest(value: unknown): ValidationResult<QuestionRequest> {
  const input = record(value);
  if (!input || !Array.isArray(input.questions) || input.questions.length === 0) {
    return { ok: false, error: 'questions must be a non-empty array' };
  }

  const questions: Question[] = [];
  const questionIds = new Set<string>();
  for (let index = 0; index < input.questions.length; index += 1) {
    const raw = record(input.questions[index]);
    if (!raw) return { ok: false, error: `questions[${index}] must be an object` };

    const id = requiredString(raw.id, `questions[${index}].id`);
    if (!id.ok) return id;
    if (questionIds.has(id.value)) return { ok: false, error: `Duplicate question id: ${id.value}` };
    questionIds.add(id.value);

    const header = requiredString(raw.header, `questions[${index}].header`);
    if (!header.ok) return header;
    const prompt = requiredString(raw.question, `questions[${index}].question`);
    if (!prompt.ok) return prompt;
    if (!Array.isArray(raw.options) || raw.options.length < 2) {
      return { ok: false, error: `questions[${index}].options must contain at least two options` };
    }
    if (raw.multiple !== undefined && typeof raw.multiple !== 'boolean') {
      return { ok: false, error: `questions[${index}].multiple must be a boolean` };
    }
    if (raw.allowOther !== undefined && typeof raw.allowOther !== 'boolean') {
      return { ok: false, error: `questions[${index}].allowOther must be a boolean` };
    }

    const options: QuestionOption[] = [];
    const optionValues = new Set<string>();
    for (let optionIndex = 0; optionIndex < raw.options.length; optionIndex += 1) {
      const option = record(raw.options[optionIndex]);
      if (!option) return { ok: false, error: `questions[${index}].options[${optionIndex}] must be an object` };
      const optionValue = requiredString(option.value, `questions[${index}].options[${optionIndex}].value`);
      if (!optionValue.ok) return optionValue;
      if (optionValues.has(optionValue.value)) {
        return { ok: false, error: `Duplicate option value for ${id.value}: ${optionValue.value}` };
      }
      optionValues.add(optionValue.value);
      const label = requiredString(option.label, `questions[${index}].options[${optionIndex}].label`);
      if (!label.ok) return label;
      if (option.description !== undefined && typeof option.description !== 'string') {
        return { ok: false, error: `questions[${index}].options[${optionIndex}].description must be a string` };
      }
      const description = typeof option.description === 'string' ? option.description.trim() : undefined;
      options.push({
        value: optionValue.value,
        label: label.value,
        ...(description ? { description } : {}),
      });
    }

    questions.push({
      id: id.value,
      header: header.value,
      question: prompt.value,
      options,
      multiple: raw.multiple ?? false,
      allowOther: raw.allowOther ?? true,
    });
  }

  return { ok: true, value: { questions } };
}

export function validateQuestionAnswers(
  request: QuestionRequest,
  value: unknown,
): ValidationResult<QuestionAnswerSubmission> {
  const input = record(value);
  if (!input || !Array.isArray(input.answers)) {
    return { ok: false, error: 'answers must be an array' };
  }
  if (input.answers.length !== request.questions.length) {
    return { ok: false, error: 'Exactly one answer is required for each question' };
  }

  const rawByQuestion = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < input.answers.length; index += 1) {
    const raw = record(input.answers[index]);
    if (!raw) return { ok: false, error: `answers[${index}] must be an object` };
    const questionId = requiredString(raw.questionId, `answers[${index}].questionId`);
    if (!questionId.ok) return questionId;
    if (rawByQuestion.has(questionId.value)) {
      return { ok: false, error: `Duplicate answer for question: ${questionId.value}` };
    }
    rawByQuestion.set(questionId.value, raw);
  }

  const answers: QuestionAnswer[] = [];
  for (const question of request.questions) {
    const raw = rawByQuestion.get(question.id);
    if (!raw) return { ok: false, error: `Missing answer for question: ${question.id}` };
    if (!Array.isArray(raw.selected) || raw.selected.some((item) => typeof item !== 'string')) {
      return { ok: false, error: `selected must be a string array for question: ${question.id}` };
    }
    const selected = raw.selected.map((item) => item.trim());
    if (selected.some((item) => item === '')) {
      return { ok: false, error: `Selections must be non-empty for question: ${question.id}` };
    }
    if (new Set(selected).size !== selected.length) {
      return { ok: false, error: `Duplicate selection for question: ${question.id}` };
    }
    const allowed = new Set(question.options.map((option) => option.value));
    if (selected.some((item) => !allowed.has(item))) {
      return { ok: false, error: `Unknown selection for question: ${question.id}` };
    }
    if (!question.multiple && selected.length > 1) {
      return { ok: false, error: `Question ${question.id} allows only one selection` };
    }
    if (raw.custom !== undefined && typeof raw.custom !== 'string') {
      return { ok: false, error: `custom must be a string for question: ${question.id}` };
    }
    const custom = typeof raw.custom === 'string' ? raw.custom.trim() : undefined;
    if (custom && !question.allowOther) {
      return { ok: false, error: `Question ${question.id} does not allow a custom answer` };
    }
    if (selected.length === 0 && !custom) {
      return { ok: false, error: `Question ${question.id} is unanswered` };
    }
    answers.push({
      questionId: question.id,
      selected,
      ...(custom ? { custom } : {}),
    });
    rawByQuestion.delete(question.id);
  }
  if (rawByQuestion.size > 0) {
    return { ok: false, error: `Unknown question: ${rawByQuestion.keys().next().value}` };
  }

  return { ok: true, value: { answers } };
}

export function formatQuestionResult(result: QuestionToolResult, request?: QuestionRequest): string {
  if (result.status === 'cancelled') {
    return `Question cancelled: ${result.error}\n\n${JSON.stringify({ toolCallId: result.toolCallId, cancelled: true, error: result.error })}`;
  }

  const readable = result.answers.map((answer) => {
    const question = request?.questions.find((item) => item.id === answer.questionId);
    const header = question?.header ?? answer.questionId;
    const labels = answer.selected.map((selection) =>
      question?.options.find((option) => option.value === selection)?.label ?? selection);
    if (answer.custom) labels.push(answer.custom);
    return `${header}: ${labels.join(', ')}`;
  }).join('\n');
  return `${readable}\n\n${JSON.stringify({ toolCallId: result.toolCallId, answers: result.answers })}`;
}

interface PendingQuestion {
  threadId: string;
  toolCallId: string;
  request: QuestionRequest;
  resolve: (result: QuestionToolResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>();

  register(
    threadId: string,
    toolCallId: string,
    request: QuestionRequest,
    signal?: AbortSignal,
  ): Promise<QuestionToolResult> {
    const key = this.key(threadId, toolCallId);
    if (this.pending.has(key)) return Promise.reject(new Error(`Question already pending: ${toolCallId}`));

    return new Promise<QuestionToolResult>((resolve) => {
      const entry: PendingQuestion = { threadId, toolCallId, request, resolve, signal };
      entry.onAbort = () => this.cancelEntry(key, this.abortReason(signal));
      this.pending.set(key, entry);
      if (signal?.aborted) entry.onAbort();
      else signal?.addEventListener('abort', entry.onAbort, { once: true });
    });
  }

  answer(threadId: string, toolCallId: string, submission: unknown): QuestionAnswerResponse {
    const key = this.key(threadId, toolCallId);
    const entry = this.pending.get(key);
    if (!entry) return { ok: false, status: 404, error: 'Question not found' };
    const validated = validateQuestionAnswers(entry.request, submission);
    if (!validated.ok) return { ok: false, status: 400, error: validated.error };

    this.remove(key, entry);
    entry.resolve({ status: 'answered', toolCallId, answers: validated.value.answers });
    return { ok: true };
  }

  cancelThread(threadId: string, reason: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.threadId === threadId) this.cancelEntry(key, reason);
    }
  }

  private cancelEntry(key: string, reason: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.remove(key, entry);
    entry.resolve({ status: 'cancelled', toolCallId: entry.toolCallId, error: reason });
  }

  private remove(key: string, entry: PendingQuestion): void {
    this.pending.delete(key);
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
  }

  private abortReason(signal?: AbortSignal): string {
    const reason = signal?.reason;
    if (typeof reason === 'string' && reason.trim()) return reason;
    if (reason instanceof Error && reason.message) return reason.message;
    return 'Question cancelled';
  }

  private key(threadId: string, toolCallId: string): string {
    return `${threadId}:${toolCallId}`;
  }
}
