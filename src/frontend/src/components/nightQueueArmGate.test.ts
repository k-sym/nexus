import { describe, expect, it } from 'vitest';
import { armGate } from './nightQueueArmGate';
import type { AssessmentResponse, NightQueueCandidate } from '../api';

const candidate = (over: Partial<NightQueueCandidate> = {}): NightQueueCandidate => ({
  repo: 'quasar-scoreboard', number: 3, title: 'Layout bug', url: 'u',
  updated_at: null, updated_ts: null, labels: [], queued: false, excluded: false,
  open_pr: null, blocked: null, ...over,
});

const verdict = (over: Partial<AssessmentResponse> = {}): AssessmentResponse => ({
  repo: 'quasar-scoreboard', number: 3, title: 't', url: 'u', state: 'OPEN',
  labels: [], queued: false, excluded: false, open_pr: null,
  ready: true, assessed: true, summary: '', criteria: [],
  draft_comment: '', ...over,
});

const GOOD_DRAFT = '**Goal:** keep the layout stable while entering scores, verifiably.';

describe('armGate', () => {
  it('allows arming an assessed, unblocked issue with a resolved draft', () => {
    const gate = armGate(candidate(), verdict(), GOOD_DRAFT);
    expect(gate.canArm).toBe(true);
    expect(gate.refusal).toBeNull();
  });

  it('refuses before an assessment exists', () => {
    expect(armGate(candidate(), null, GOOD_DRAFT).refusal).toBe('not-assessed');
  });

  it('refuses a verdict belonging to a different issue', () => {
    // The stale-assessment race: arming would take the repo from the candidate
    // and the comment from the old verdict, posting the wrong spec.
    const stale = verdict({ repo: 'wisesafety', number: 211 });
    expect(armGate(candidate(), stale, GOOD_DRAFT).refusal).toBe('stale-assessment');
    const sameRepoOtherIssue = verdict({ number: 4 });
    expect(armGate(candidate(), sameRepoOtherIssue, GOOD_DRAFT).refusal).toBe('stale-assessment');
  });

  it('refuses every structural blocker, each with its own reason', () => {
    for (const [blocked, refusal] of [
      ['excluded', 'excluded'], ['queued', 'queued'], ['open_pr', 'open-pr'],
    ] as const) {
      const gate = armGate(candidate({ blocked }), verdict(), GOOD_DRAFT);
      expect(gate.canArm, blocked).toBe(false);
      expect(gate.refusal, blocked).toBe(refusal);
      expect(gate.reason, blocked).toBeTruthy();
    }
  });

  it('refuses an unknown future blocker rather than allowing it', () => {
    const gate = armGate(candidate({ blocked: 'quarantined' as any }), verdict(), GOOD_DRAFT);
    expect(gate.canArm).toBe(false);
  });

  it('refuses a draft that still holds a TODO', () => {
    const draft = '**Goal:** x\n**Acceptance checks:** <TODO: name one> plus padding text.';
    expect(armGate(candidate(), verdict(), draft).refusal).toBe('unresolved-todo');
  });

  it('refuses a draft too short to be a spec', () => {
    expect(armGate(candidate(), verdict(), 'looks fine').refusal).toBe('too-short');
    expect(armGate(candidate(), verdict(), '   ').refusal).toBe('too-short');
  });

  it('does not require the assessment to say ready — Keith may overrule the bar', () => {
    // The bar informs; the human decides. A "below the bar" verdict with a
    // draft that closes the gaps is exactly the workshop's normal outcome.
    const gate = armGate(candidate(), verdict({ ready: false }), GOOD_DRAFT);
    expect(gate.canArm).toBe(true);
  });
});
