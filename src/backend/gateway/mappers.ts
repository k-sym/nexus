/**
 * Pure mappers: Nexus internal shapes → glasses cockpit wire shapes.
 *
 * Kept side-effect-free so they can be unit-tested without a running backend.
 */
import type { QuestionRequest, QuestionAnswer, PendingQuestionView } from '../pi/questions.js';
import type { PendingApprovalView } from '../pi/approvals.js';
import type { Approval, TranscriptEvent, Attention } from './types.js';

/** Coerce a pi timestamp (ISO string or epoch ms) to epoch ms. */
export function toMs(ts: unknown): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

interface FlattenedToolCall {
  name?: string;
  args?: unknown;
}

interface FlattenedMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content?: string;
  tool_calls?: FlattenedToolCall[] | null;
  timestamp?: unknown;
}

/**
 * Expand `flattenEntries()` output into the flat user/assistant_text/tool_use
 * event stream the glasses render, keeping only the last `limit` events.
 */
export function messagesToTranscriptEvents(messages: unknown[], limit = 40): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const raw of messages as FlattenedMessage[]) {
    if (!raw || typeof raw !== 'object') continue;
    const ts = toMs(raw.timestamp);
    if (raw.role === 'user') {
      const text = typeof raw.content === 'string' ? raw.content : '';
      events.push({ kind: 'user', text, ts });
    } else if (raw.role === 'assistant') {
      const text = typeof raw.content === 'string' ? raw.content : '';
      if (text.trim()) events.push({ kind: 'assistant_text', text, ts });
      for (const call of raw.tool_calls ?? []) {
        events.push({ kind: 'tool_use', name: call?.name, input: call?.args, ts });
      }
    }
    // toolResult rows are not part of the glasses transcript vocabulary.
  }
  return events.slice(-limit);
}

/** A chat session waiting on a `question` tool → the glasses "needs you" state. */
export function waitingAttention(): Attention {
  return { type: 'agent_needs_input', message: 'Waiting for your answer' };
}

function questionTitle(request: QuestionRequest): string {
  const first = request.questions[0];
  const label = first?.header?.trim() || first?.question?.trim() || 'Question';
  const extra = request.questions.length > 1 ? ` (+${request.questions.length - 1})` : '';
  return `${truncate(label, 60)}${extra}`;
}

/**
 * A pending Nexus `question` → a glasses `Approval{kind:'question'}`. The glasses
 * render each question's options as tappable rows and answer by posting
 * `{ [questionText]: chosenLabel }` back to `/api/approvals/:id/decision`.
 */
export function questionToApproval(view: PendingQuestionView, cwd: string): Approval {
  return {
    id: view.toolCallId,
    kind: 'question',
    session_id: view.threadId,
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: view.request.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiple,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
      })),
    },
    cwd,
    title: questionTitle(view.request),
    createdAt: view.requestedAt,
    decision: null,
  };
}

/** Build a short, human "what" line for a tool-gate approval from the tool name
 *  and a best-effort summary of its most telling argument (command, path, …). */
function approvalTitle(toolName: string, input: unknown): string {
  const args = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const detailKeys = ['command', 'cmd', 'file_path', 'path', 'filePath', 'pattern', 'query', 'url'];
  let detail = '';
  if (args) {
    for (const key of detailKeys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) { detail = value.trim(); break; }
    }
  }
  return detail ? `${toolName}: ${truncate(detail, 60)}` : toolName;
}

/**
 * A pending Nexus tool-gate → a glasses `Approval{kind:'approval'}`. The glasses
 * render the what·where·then and answer by posting `{ action:'allow'|'deny' }`
 * back to `/api/approvals/:id/decision`. The view already carries the cwd, so —
 * unlike a question approval — no thread→cwd lookup is needed.
 */
export function toolCallToApproval(view: PendingApprovalView): Approval {
  return {
    id: view.toolCallId,
    kind: 'approval',
    session_id: view.threadId,
    tool_name: view.toolName,
    tool_input: view.input,
    cwd: view.cwd,
    title: approvalTitle(view.toolName, view.input),
    createdAt: view.requestedAt,
    decision: null,
  };
}

/**
 * Translate the glasses' answer payload — `{ [questionText]: chosenLabel }`,
 * keyed by question *text* with the option *label* as the value — into Nexus's
 * `{ answers: [{ questionId, selected:[optionValue], custom? }] }`.
 *
 * Falls back to a free-text `custom` answer when the label doesn't match a
 * known option (covers the glasses "Speak answer" / other path), so long as the
 * question allows it.
 */
export function translateGlassesAnswer(
  request: QuestionRequest,
  glassesAnswers: Record<string, string>,
): { answers: QuestionAnswer[] } {
  const singleValue = Object.values(glassesAnswers)[0];
  const answers: QuestionAnswer[] = request.questions.map((q) => {
    // The glasses key by exact question text; tolerate header-keyed or, for a
    // single-question prompt, an unkeyed lone value.
    const chosen =
      glassesAnswers[q.question] ??
      (q.header ? glassesAnswers[q.header] : undefined) ??
      (request.questions.length === 1 ? singleValue : undefined);
    if (chosen === undefined || chosen === '') {
      return { questionId: q.id, selected: [] };
    }
    const option = q.options.find((o) => o.label === chosen || o.value === chosen);
    if (option) return { questionId: q.id, selected: [option.value] };
    // Unknown label → free-text answer when permitted.
    return q.allowOther
      ? { questionId: q.id, selected: [], custom: chosen }
      : { questionId: q.id, selected: [] };
  });
  return { answers };
}
