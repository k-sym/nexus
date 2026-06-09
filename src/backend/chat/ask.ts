/**
 * ASK_CONVENTION — string the agent appends to its system prompt to teach
 * the model to emit a structured ```ask``` block when it wants to ask the
 * user a multiple-choice question.
 *
 * STUB — kept temporarily so the build stays green. The legacy
 * `orchestrator/providers.ts` (which used `ASK_CONVENTION`) was deleted
 * in Phase 3. Nothing imports from here now; the file will be removed
 * in a follow-up commit.
 */
export const ASK_CONVENTION = '';

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

export function parseAskBlock(_reply: string): Ask | null {
  return null;
}

export interface AnswerSet {
  replies: Array<{ question: string; selections: string[]; freeText?: string }>;
}

export function buildAnswerSummary(_ask: Ask, _replies: AnswerSet['replies']): string {
  return '';
}
