/**
 * ASK_CONVENTION — string the agent appends to its system prompt to teach
 * the model to emit a structured ```ask``` block when it wants to ask the
 * user a multiple-choice question. The agent's reply is parsed by
 * `parseAskBlock` and surfaced to the user as a `QuestionCard`.
 *
 * Note: This module is slated for deletion in Phase 3 when the orchestrator
 * stops using it. Until then, `orchestrator/providers.ts` imports
 * `ASK_CONVENTION` from here. After Phase 3, the file is removed along
 * with `routes/chat.ts`'s `parseAskBlock` consumer.
 */
export const ASK_CONVENTION = `When you want to ask the user a multiple-choice question, emit a single code block in your reply wrapped exactly like this:

\`\`\`ask
{ "questions": [ ... ] }
\`\`\`

Rules:
- Use it sparingly. Only when you need a structured decision from the user.
- The block must be the LAST block in your message. No prose after it.
- Each question's \`options\` array must have 2-4 entries.`;

interface AskJson {
  questions: Array<{
    header: string;
    question: string;
    options: { label: string; description: string }[];
    multiple?: boolean;
    custom?: boolean;
  }>;
}

export interface Ask {
  preamble: string;
  ask: {
    questions: Array<{
      header: string;
      question: string;
      options: { label: string; description: string }[];
      multiple: boolean;
      custom: boolean;
    }>;
  };
}

/** Extract a ```ask``` block from a model reply. Returns null if none. */
export function parseAskBlock(reply: string): Ask | null {
  const re = /```ask\s*\n([\s\S]*?)\n```/m;
  const m = re.exec(reply);
  if (!m) return null;
  let parsed: AskJson;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!parsed?.questions?.length) return null;
  const preamble = reply.slice(0, m.index).trim();
  const questions = parsed.questions.map((q) => ({
    header: String(q.header ?? '').slice(0, 30),
    question: String(q.question ?? ''),
    options: (q.options ?? []).map((o) => ({
      label: String(o.label ?? ''),
      description: String(o.description ?? ''),
    })),
    multiple: Boolean(q.multiple),
    custom: q.custom === undefined ? true : Boolean(q.custom),
  }));
  return { preamble, ask: { questions } };
}

export interface AnswerSet {
  replies: Array<{ question: string; selections: string[]; freeText?: string }>;
}

/** Build a human-readable summary of an AnswerSet for the next user turn. */
export function buildAnswerSummary(ask: Ask, replies: AnswerSet['replies']): string {
  return replies
    .map((r) => {
      const q = ask.ask.questions.find((x) => x.question === r.question);
      const header = q?.header ?? r.question.slice(0, 30);
      const labels = r.selections
        .map((sel) => q?.options.find((o) => o.label === sel)?.label ?? sel)
        .join(', ');
      return `${header}: ${labels}${r.freeText ? ` (${r.freeText})` : ''}`;
    })
    .join('\n');
}
