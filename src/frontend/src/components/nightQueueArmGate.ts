import type { AssessmentResponse, NightQueueCandidate } from '../api';

/**
 * Whether the workshop may offer to arm, and why not when it may not.
 *
 * Lifted out of the component deliberately. All three bugs found while driving
 * the desktop workshop lived in this decision when it was an inline boolean:
 * a stale verdict from a different issue could satisfy it, an open PR did not
 * block it, and a `<TODO:` could slip through while the panel re-rendered. iOS
 * has the same logic as a tested `ArmGate` in NexusCore (nexus#403); this is
 * the desktop half of that parity, so the refusal rules can be tested without
 * a DOM.
 *
 * Every rule here is mirrored server-side in `arming.py` — this exists so the
 * button says WHY before a round trip, never so the client is the one deciding.
 */

export const UNRESOLVED_MARKER = '<TODO';
export const MIN_COMMENT_CHARS = 40;

export type ArmRefusal =
  | 'not-assessed'
  | 'stale-assessment'
  | 'excluded'
  | 'queued'
  | 'open-pr'
  | 'unresolved-todo'
  | 'too-short';

export interface ArmGate {
  canArm: boolean;
  refusal: ArmRefusal | null;
  /** Shown on the disabled button; short enough for a title attribute. */
  reason: string | null;
}

const REASONS: Record<ArmRefusal, string> = {
  'not-assessed': 'Assess it against the bar first',
  'stale-assessment': 'This verdict is for a different issue',
  excluded: 'This repo never runs unattended by standing policy',
  queued: 'Already labelled — it is in tonight’s run',
  'open-pr': 'A PR already implements this',
  'unresolved-todo': 'Resolve the <TODO:> first',
  'too-short': 'The readiness comment is too short to be a spec',
};

export function armGate(
  candidate: NightQueueCandidate,
  assessment: AssessmentResponse | null,
  draft: string,
): ArmGate {
  const refuse = (refusal: ArmRefusal): ArmGate => ({
    canArm: false,
    refusal,
    reason: REASONS[refusal],
  });

  if (!assessment) return refuse('not-assessed');
  // The stale-assessment race: an in-flight verdict can land after the user
  // switched issues. Arming then takes the repo from the NEW candidate and the
  // comment from the OLD one — the wrong spec posted onto the wrong issue.
  if (assessment.repo !== candidate.repo || assessment.number !== candidate.number) {
    return refuse('stale-assessment');
  }
  // `blocked` covers all three structural refusals at once. Checking them
  // individually is how `open_pr` got missed: the banner warned, the button
  // armed anyway, and the adapter does not refuse duplicates either.
  if (candidate.blocked === 'excluded') return refuse('excluded');
  if (candidate.blocked === 'queued') return refuse('queued');
  if (candidate.blocked === 'open_pr') return refuse('open-pr');
  if (candidate.blocked !== null) return refuse('open-pr');

  if (draft.includes(UNRESOLVED_MARKER)) return refuse('unresolved-todo');
  if (draft.trim().length < MIN_COMMENT_CHARS) return refuse('too-short');

  return { canArm: true, refusal: null, reason: null };
}
