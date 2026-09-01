import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NightQueueWorkshop from './NightQueueWorkshop';
import { api } from '../api';

vi.mock('../hooks/useIdeaThread', () => ({
  useIdeaThread: (sessionId: string | null) => ({
    messages: sessionId
      ? [{ id: 'm1', role: 'assistant', content: '**Goal:** a spec the Partner proposed, long enough to arm with.' }]
      : [],
    latestRun: null, isRunning: false, loading: false, error: null,
    send: vi.fn(), abort: vi.fn(), reload: vi.fn(),
  }),
}));

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
    const box = screen.getByRole('textbox', { name: 'Readiness comment' }) as HTMLTextAreaElement;
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

  it('opens a conversation carrying the working draft, not the assessor\'s first attempt', async () => {
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);
    vi.spyOn(api.nightQueue, 'assess').mockResolvedValue(assessment('quasar-scoreboard', 3));
    const adopt = vi.spyOn(api.assistant, 'importRemote')
      .mockResolvedValue({ session: { id: 'nexus-1' } } as any);
    const discuss = vi.spyOn(api.nightQueue, 'discuss')
      .mockResolvedValue({ session_id: 's1', repo: 'quasar-scoreboard', number: 3,
                           title: 't', url: 'u', session_title: 'night-queue: quasar-scoreboard#3' } as any);
    render(<NightQueueWorkshop />);

    fireEvent.click(await screen.findByText(/Layout bug/));
    fireEvent.click(await screen.findByText(/Assess against the bar/));
    await screen.findByText(/verdict for quasar-scoreboard#3/);

    // Edit the draft first — what travels must be what is on screen.
    const box = screen.getByRole('textbox', { name: 'Readiness comment' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'my own edited spec, long enough to matter here.' } });

    fireEvent.click(screen.getByText(/Discuss with the Partner/));
    await waitFor(() => expect(discuss).toHaveBeenCalledWith(
      'quasar-scoreboard', 3, 'my own edited spec, long enough to matter here.'));
    // The adapter's session id must be ADOPTED into a nexus one before the
    // per-session chat endpoints can drive it — they are keyed by nexus ids,
    // and passing the raw adapter id 404s.
    await waitFor(() => expect(adopt).toHaveBeenCalledWith('s1'));
  });

  it('lifts a proposed comment into the draft rather than making you retype it', async () => {
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);
    vi.spyOn(api.nightQueue, 'assess').mockResolvedValue(assessment('quasar-scoreboard', 3));
    vi.spyOn(api.nightQueue, 'discuss').mockResolvedValue({ session_id: 's1' } as any);
    vi.spyOn(api.assistant, 'importRemote').mockResolvedValue({ session: { id: 'nexus-1' } } as any);
    render(<NightQueueWorkshop />);

    fireEvent.click(await screen.findByText(/Layout bug/));
    fireEvent.click(await screen.findByText(/Assess against the bar/));
    await screen.findByText(/verdict for quasar-scoreboard#3/);
    fireEvent.click(screen.getByText(/Discuss with the Partner/));

    fireEvent.click(await screen.findByText(/Use this as the readiness comment/));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Readiness comment' }) as HTMLTextAreaElement).value)
      .toMatch(/a spec the Partner proposed/));
  });

  it('drops the conversation when you switch issues', async () => {
    // Issue A's discussion must not appear under issue B's heading — the same
    // class of bug as the stale assessment.
    vi.spyOn(api.nightQueue, 'candidates').mockResolvedValue(CANDIDATES as any);
    vi.spyOn(api.nightQueue, 'readiness').mockResolvedValue(READINESS as any);
    vi.spyOn(api.nightQueue, 'assess').mockImplementation((repo: string, number: number) =>
      Promise.resolve(assessment(repo, number)));
    vi.spyOn(api.nightQueue, 'discuss').mockResolvedValue({ session_id: 's1' } as any);
    vi.spyOn(api.assistant, 'importRemote').mockResolvedValue({ session: { id: 'nexus-1' } } as any);
    render(<NightQueueWorkshop />);

    fireEvent.click(await screen.findByText(/Layout bug/));
    fireEvent.click(await screen.findByText(/Assess against the bar/));
    await screen.findByText(/verdict for quasar-scoreboard#3/);
    fireEvent.click(screen.getByText(/Discuss with the Partner/));
    await screen.findByText(/a spec the Partner proposed/);

    fireEvent.click(screen.getByText(/Training content/));
    await waitFor(() =>
      expect(screen.queryByText(/a spec the Partner proposed/)).toBeNull());
  });
});
