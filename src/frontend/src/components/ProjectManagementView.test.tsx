import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProjectManagementView } from './ProjectManagementView';
import * as api from '../api';

const ITEM = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: 'g1', group_title: 'Q3',
  name: 'Ship the thing', state: 'active' as const, status_label: 'Working on it', status_color: null,
  owners_json: '["Keith Symmonds"]', url: 'https://x.monday.com/1', column_values_json: '{}',
  monday_updated_at: null, synced_at: 'now',
  rollup: { total: 3, open: 1, inProgress: 0, inReview: 1, done: 1 },
  rollup_text: '1/3 done · 1 in review',
  task_ids: ['t1', 't2', 't3'],
};

const OTHER_ITEM = { ...ITEM, item_id: '2', name: 'Other project item', group_title: 'Q4' };

/** A promise whose resolution is controlled by the caller, so tests can force
 *  a specific settle order for concurrent requests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.restoreAllMocks());

describe('ProjectManagementView', () => {
  it('renders items grouped by Monday group with their roll-up', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    expect(screen.getByText('1/3 done · 1 in review')).toBeTruthy();
    expect(screen.getByText('Q3')).toBeTruthy();
  });

  it('shows an empty state when no items are mirrored', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/no monday items/i)).toBeTruthy();
  });

  it('flags an item that is no longer in Monday', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([{ ...ITEM, state: 'missing' }] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/unavailable/i)).toBeTruthy();
  });

  it('surfaces a load failure instead of rendering an empty board', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(new Error('Not Authenticated'));
    render(<ProjectManagementView projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/Not Authenticated/)).toBeTruthy());
    expect(screen.queryByText(/no monday items/i)).toBeNull();
  });

  it('marks the error banner for assistive technology', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(new Error('Not Authenticated'));
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('still shows the header and a refresh control when the project has zero items', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([] as never);
    render(<ProjectManagementView projectId="p1" />);
    await screen.findByText(/no monday items/i);
    expect(screen.getByRole('button', { name: /refresh from monday/i })).toBeTruthy();
  });

  it('shows the newer project\'s items when the older project\'s request resolves last', async () => {
    const forP1 = deferred<typeof ITEM[]>();
    const forP2 = deferred<typeof ITEM[]>();
    vi.spyOn(api, 'fetchMondayItems').mockImplementation(async (projectId: string) => {
      return projectId === 'p1' ? forP1.promise : forP2.promise;
    });

    const { rerender } = render(<ProjectManagementView projectId="p1" />);
    rerender(<ProjectManagementView projectId="p2" />);

    // The newer request (p2) resolves first; the stale one (p1) resolves after.
    forP2.resolve([OTHER_ITEM]);
    await screen.findByText('Other project item');

    forP1.resolve([ITEM]);
    // Give the stale (now-resolved) promise a tick to (incorrectly) apply its state.
    await waitFor(() => expect(screen.getByText('Other project item')).toBeTruthy());
    expect(screen.queryByText('Ship the thing')).toBeNull();
  });

  it('keeps showing items and surfaces an inline error when a refresh fails after a successful load', async () => {
    const spy = vi.spyOn(api, 'fetchMondayItems');
    spy.mockResolvedValueOnce([ITEM] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();

    spy.mockRejectedValueOnce(Object.assign(new Error('Monday request failed'), { retryable: true }));
    fireEvent.click(screen.getByRole('button', { name: /refresh from monday/i }));

    await waitFor(() => expect(screen.getByText(/Monday request failed/)).toBeTruthy());
    // The previously-loaded item must still be visible — a failed refresh
    // must never throw away still-valid data.
    expect(screen.getByText('Ship the thing')).toBeTruthy();
    expect(screen.queryByText(/no monday items/i)).toBeNull();
  });

  it('shows a Retry button when the failure is retryable (or unknown)', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(
      Object.assign(new Error('Rate limited by Monday'), { code: 'RATE_LIMITED', retryable: true }),
    );
    render(<ProjectManagementView projectId="p1" />);
    await screen.findByText(/Rate limited by Monday/);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('hides the Retry button and asks the user to fix config when the failure is explicitly not retryable', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(
      Object.assign(new Error('Monday token expired'), { code: 'AUTH_EXPIRED', retryable: false }),
    );
    render(<ProjectManagementView projectId="p1" />);
    await screen.findByText(/Monday token expired/);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByText(/token or board configuration/i)).toBeTruthy();
  });
});
