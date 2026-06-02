/**
 * Parse a fenced ```ask``` block (or <ask_user> fallback) out of an agent's text
 * output into a structured Ask, and build the human-readable answer summary that
 * becomes the user's continuation turn. Pure — no DB or IO. See
 * project_docs/2026-06-02-interactive-question-messages-design.md.
 */
import type { Ask, Question, QuestionOption, Reply } from '@nexus/shared';

const FENCE_RE = /```ask\s*\n([\s\S]*?)```/;
const TAG_RE = /<ask_user>\s*([\s\S]*?)<\/ask_user>/;

export interface ParsedAsk {
  /** Text before the block, trimmed (the question's preamble). */
  preamble: string;
  ask: Ask;
}

/** Extract the first valid ask block. Returns null if absent or malformed. */
export function parseAskBlock(output: string): ParsedAsk | null {
  if (!output) return null;

  let raw: string | null = null;
  let start = -1;

  const fence = FENCE_RE.exec(output);
  if (fence) {
    raw = fence[1];
    start = fence.index;
  } else {
    const tag = TAG_RE.exec(output);
    if (tag) {
      raw = tag[1];
      start = tag.index;
    }
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  const ask = normalizeAsk(parsed);
  if (!ask) return null;

  return { preamble: output.slice(0, start).trim(), ask };
}

/** Validate + apply defaults (multiple=false, custom=true). Null on bad shape. */
function normalizeAsk(parsed: unknown): Ask | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const questions = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const out: Question[] = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') return null;
    const qq = q as Record<string, unknown>;
    if (typeof qq.header !== 'string' || typeof qq.question !== 'string') return null;
    if (!Array.isArray(qq.options) || qq.options.length === 0) return null;

    const options: QuestionOption[] = [];
    for (const o of qq.options) {
      if (!o || typeof (o as Record<string, unknown>).label !== 'string') return null;
      const oo = o as Record<string, unknown>;
      options.push({
        label: oo.label as string,
        description: typeof oo.description === 'string' ? oo.description : '',
      });
    }

    out.push({
      header: (qq.header as string).slice(0, 30),
      question: qq.question as string,
      options,
      multiple: qq.multiple === true,
      custom: qq.custom !== false,
    });
  }
  return { questions: out };
}

/** Build the OpenCode-style summary fed back to the agent as the next turn. */
export function buildAnswerSummary(ask: Ask, replies: Reply[]): string {
  const parts = ask.questions.map((q, i) => {
    const r = replies[i];
    const chosen = r ? [...r.selected, ...(r.custom ? [r.custom] : [])] : [];
    const ans = chosen.length ? chosen.join(', ') : 'Unanswered';
    return `"${q.question}"="${ans}"`;
  });
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
}

/** Injected into every persona's system prompt so any provider can ask. */
export const ASK_CONVENTION = [
  '## Asking the user questions',
  '',
  'When you need a decision, preference, or clarification, you MAY end your reply with a single',
  'fenced code block tagged `ask` containing JSON:',
  '',
  '```ask',
  '{ "questions": [ { "header": "Short label", "question": "Full question?", "multiple": false,',
  '  "options": [ { "label": "Option A", "description": "what this means" },',
  '               { "label": "Option B", "description": "..." } ] } ] }',
  '```',
  '',
  'Rules:',
  '- "header" is a short label (max 30 chars). Each option has a "label" (1-5 words) and "description".',
  '- A "Type your own answer" free-text option is added automatically — do NOT add your own "Other" option.',
  '- If you recommend an option, put it first and suffix its label with "(Recommended)".',
  '- Set "multiple": true to let the user select more than one option.',
  '- Put the block LAST, after any explanatory text. Only use it when you genuinely need the user’s input.',
].join('\n');
