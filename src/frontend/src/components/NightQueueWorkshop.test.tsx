import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NightQueueWorkshop from './NightQueueWorkshop';
import { api } from '../api';

const CANDIDATES = {
  configured: true,
  unblocked: 1,
  candidates: [
    { repo: 'quasar-scoreboard', number: 3, title: 'Layout bug', url: 'u3',
      updated_at: null, updated_ts: null, labels: [], queued: false, excluded: false,
      open_pr: null, blocked: null },
    { repo: 'wisesafety', number: 211, title: 'Training content', url: 'u211',
      updated_at: null, updated_ts: null, labels: [], queued: false, excluded: false,
      open_pr: { number: 212, url: 'p212', branch: 'fix/issue-211-x', reason: 'linked' },
      blocked: 'open_pr' },
    { repo: 'nexus', number: 401, title: 'Stats card', url: 'u401',
      updated_at: null, updated_ts: null, labels: [], queued: false, excluded: true,
      open_pr: null, blocked: 'excluded' },
  ],
};

const READINESS = {
  configured: true,
  criteria: [
    { id: 'outcome', label: 'Stated outcome', requirement: 'What should be true', conditional: null },
  ],
  bar_text: 'READINESS BAR — ...',
};

function assessment(repo: string, number: number, over: Record<string, unknown> = {}) {
  return {
    repo, number, title: 't', url: 'u', state: 'OPEN', labels: [],
    queued: false, excluded: false, open_pr: null,
    ready: true, assessed: true, summary: `verdict for ${repo}#${number}`,
    criteria: [{ id: 'outcome', label: 'Stated outcome', status: 'met', note: 'fine' }],
    draft_comment: `**Goal:** spec written for ${repo}#${number}, long enough to pass the length gate.`,
    ...over,
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('NightQueueWorkshop', () => {
  it('shows blocked candidates rather than hiding them, with the reason', async () => {
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);
    render(<NightQueueWorkshop />);

    await screen.findByText(/quasar-scoreboard#3/);
    // A list that omits a blocked issue teaches you it does not exist.
    expect(screen.getByText(/wisesafety#211/)).toBeTruthy();
    expect(screen.getByText(/nexus#401/)).toBeTruthy();
    expect(screen.getAllByText(/PR #212 already implements this/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 unblocked · 3 open/i)).toBeTruthy();
  });

  it('does not offer to arm an issue blocked by an open PR', async () => {
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);
    vi.spyOn(api.nightQueue, 'assess').mockResolvedValue(assessment('wisesafety', 211));
    render(<NightQueueWorkshop />);

    fireEvent.click(await screen.findByText(/Training content/));
    fireEvent.click(await screen.findByText(/Assess against the bar/));
    await screen.findByText(/verdict for wisesafety#211/);

    const arm = screen.getByRole('button', { name: /Post comment and arm/i }) as HTMLButtonElement;
    expect(arm.disabled).toBe(true);
  });

  it('keeps Arm disabled while the draft still holds a TODO', async () => {
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);
    vi.spyOn(api.nightQueue, 'assess').mockResolvedValue(
      assessment('quasar-scoreboard', 3, {
        draft_comment: '**Goal:** x\n**Acceptance checks:** <TODO: name one> padding to clear the length gate.',
      }),
    );
    render(<NightQueueWorkshop />);

    fireEvent.click(await screen.findByText(/Layout bug/));
    fireEvent.click(await screen.findByText(/Assess against the bar/));
    await screen.findByText(/still contains a/);

    const arm = screen.getByRole('button', { name: /Post comment and arm/i }) as HTMLButtonElement;
    expect(arm.disabled).toBe(true);

    // Resolving the TODO in the textarea enables it.
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, {
      target: { value: '**Goal:** x\n**Acceptance checks:** `npm test` passes and the rank column stays.' },
    });
    await waitFor(() => expect((screen.getByRole('button', { name: /Post comment and arm/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('drops an assessment the user has switched away from', async () => {
    // The bug this test exists for: an assessment takes tens of seconds, so
    // switching issues mid-flight used to land verdict A under heading B —
    // and Arm took the repo from B with the comment from A, which would post
    // A's spec onto B and label it.
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);

    let releaseFirst!: () => void;
    const slow = new Promise<any>((resolve) => {
      releaseFirst = () => resolve(assessment('wisesafety', 211));
    });
    vi.spyOn(api.nightQueue, 'assess').mockImplementation((repo: string) =>
      repo === 'wisesafety' ? slow : Promise.resolve(assessment('quasar-scoreboard', 3)),
    );

    render(<NightQueueWorkshop />);
    fireEvent.click(await screen.findByText(/Training content/));
    fireEvent.click(await screen.findByText(/Assess against the bar/));

    // Switch away while #211's assessment is still in flight, then let it land.
    fireEvent.click(await screen.findByText(/Layout bug/));
    releaseFirst();

    await waitFor(() =>
      expect(screen.queryByText(/verdict for wisesafety#211/)).toBeNull(),
    );
    // And the panel is showing the new issue, un-assessed, not the stale one.
    expect(screen.getByText(/Assess against the bar/)).toBeTruthy();
  });
});
