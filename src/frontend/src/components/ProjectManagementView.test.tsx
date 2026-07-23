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

  it('flags an archived item as degraded, not as a healthy initiative', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([{ ...ITEM, state: 'archived' }] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/archived/i)).toBeTruthy();
  });

  it('flags a deleted item as degraded, not as a healthy initiative', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([{ ...ITEM, state: 'deleted' }] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/deleted/i)).toBeTruthy();
  });

  it('does not flag an active item as degraded', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
    expect(screen.queryByText(/archived/i)).toBeNull();
    expect(screen.queryByText(/deleted/i)).toBeNull();
  });

  it('syncs from Monday when the view opens, the same way the manual Refresh control does', async () => {
    // The spec: scope sync is lazy, "on Project Management view open and on
    // manual refresh". Before this fix, mount called load(false) — a
    // mirror-only read — so the first open of a correctly-configured project
    // showed the empty-board message until the user noticed Refresh.
    const spy = vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    render(<ProjectManagementView projectId="p1" />);
    await screen.findByText('Ship the thing');
    expect(spy).toHaveBeenCalledWith('p1', true);
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

  it('does not show the empty message when an error occurs after loading zero items', async () => {
    const spy = vi.spyOn(api, 'fetchMondayItems');
    spy.mockResolvedValueOnce([] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/no monday items/i)).toBeTruthy();

    spy.mockRejectedValueOnce(Object.assign(new Error('Monday request failed'), { retryable: true }));
    fireEvent.click(screen.getByRole('button', { name: /refresh from monday/i }));

    await waitFor(() => expect(screen.getByText(/Monday request failed/)).toBeTruthy());
    // The error banner must be shown, and the empty message must NOT be shown
    // to avoid the ambiguity of "no items" vs "load failed".
    expect(screen.queryByText(/no monday items/i)).toBeNull();
  });

  it('shows the non-retryable inline error message when a refresh fails with retryable: false after loading items', async () => {
    const spy = vi.spyOn(api, 'fetchMondayItems');
    spy.mockResolvedValueOnce([ITEM] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();

    spy.mockRejectedValueOnce(Object.assign(new Error('Monday token expired'), { retryable: false }));
    fireEvent.click(screen.getByRole('button', { name: /refresh from monday/i }));

    await waitFor(() => expect(screen.getByText(/Monday token expired/)).toBeTruthy());
    // The inline banner must show the non-retryable message without a Retry button
    expect(screen.getByText(/token or board configuration/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    // And the previously-loaded item must still be visible
    expect(screen.getByText('Ship the thing')).toBeTruthy();
  });

  it('unlinks a task from an item row and refreshes so the roll-up updates', async () => {
    const fetchSpy = vi.spyOn(api, 'fetchMondayItems');
    fetchSpy.mockResolvedValueOnce([ITEM] as never);
    const unlink = vi.spyOn(api, 'unlinkTaskFromMondayItem').mockResolvedValue(undefined as never);

    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    expect(screen.getByText('t1')).toBeTruthy();

    // After the unlink, the refetch reports the item with one fewer linked
    // task and an updated roll-up.
    fetchSpy.mockResolvedValueOnce([
      { ...ITEM, task_ids: ['t2', 't3'], rollup: { total: 2, open: 1, inProgress: 0, inReview: 1, done: 0 }, rollup_text: '0/2 done · 1 in review' },
    ] as never);

    fireEvent.click(screen.getByRole('button', { name: /unlink task t1/i }));

    await waitFor(() => expect(unlink).toHaveBeenCalledWith('t1'));
    // The view refetched (not just spliced local state) — the new roll-up text
    // proves the list actually reloaded rather than leaving stale state on screen.
    await waitFor(() => expect(screen.getByText('0/2 done · 1 in review')).toBeTruthy());
    expect(screen.queryByText('t1')).toBeNull();
    expect(screen.getByText('t2')).toBeTruthy();
  });

  it('surfaces an inline error, without discarding the row, when unlinking fails', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    vi.spyOn(api, 'unlinkTaskFromMondayItem').mockRejectedValue(new Error('Unlink failed'));

    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /unlink task t1/i }));

    await waitFor(() => expect(screen.getByText('Unlink failed')).toBeTruthy());
    // The row itself must still be there — a failed unlink must not silently
    // vanish the task from view.
    expect(screen.getByText('t1')).toBeTruthy();
  });

  it('does not enable t2\'s button mid-flight when t1\'s unlink settles first (concurrent unlink test)', async () => {
    // Start with three tasks: we'll unlink t1 and t2, leaving t3.
    // This keeps the item (and its task badges) visible after the first load,
    // so we can verify t2's button stays disabled while t2 is still pending.
    const initialItem = { ...ITEM, task_ids: ['t1', 't2', 't3'] };
    const fetchSpy = vi.spyOn(api, 'fetchMondayItems');
    fetchSpy.mockResolvedValueOnce([initialItem] as never);

    // Control the unlink timing: t1 unlink resolves first, t2 unlink second
    const t1Unlink = deferred<void>();
    const t2Unlink = deferred<void>();
    vi.spyOn(api, 'unlinkTaskFromMondayItem').mockImplementation(async (taskId: string) => {
      if (taskId === 't1') return t1Unlink.promise;
      if (taskId === 't2') return t2Unlink.promise;
      throw new Error(`Unexpected task id: ${taskId}`);
    });

    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    expect(screen.getByText('t1')).toBeTruthy();
    expect(screen.getByText('t2')).toBeTruthy();
    expect(screen.getByText('t3')).toBeTruthy();

    // Get initial button state
    let t1Button = screen.getByRole('button', { name: /unlink task t1/i });
    let t2Button = screen.getByRole('button', { name: /unlink task t2/i });
    let t3Button = screen.getByRole('button', { name: /unlink task t3/i });
    expect(t1Button).not.toBeDisabled();
    expect(t2Button).not.toBeDisabled();
    expect(t3Button).not.toBeDisabled();

    // Start unlink of t1 and t2 (concurrently, without waiting)
    fireEvent.click(t1Button);
    fireEvent.click(t2Button);

    // Both t1 and t2 buttons should now be disabled because their unlinks are pending
    t1Button = screen.getByRole('button', { name: /unlink task t1/i });
    t2Button = screen.getByRole('button', { name: /unlink task t2/i });
    t3Button = screen.getByRole('button', { name: /unlink task t3/i });
    await waitFor(() => {
      expect(t1Button).toBeDisabled();
      expect(t2Button).toBeDisabled();
    });
    // t3 was not clicked, so it should remain enabled
    expect(t3Button).not.toBeDisabled();

    // Mock the refresh response after t1 unlink: remove only t1, keep t2 and t3
    fetchSpy.mockResolvedValueOnce([{ ...ITEM, task_ids: ['t2', 't3'] }] as never);

    // Resolve t1's unlink first; this should NOT re-enable t2's button
    t1Unlink.resolve();

    // After load() completes, t1's button disappears (since t1 is no longer in task_ids)
    // and t2 should still have its button and still be disabled (because t2 unlink is pending)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /unlink task t1/i })).toBeNull();
      t2Button = screen.getByRole('button', { name: /unlink task t2/i });
      expect(t2Button).toBeDisabled();
    });
    // t3 should still be there and not disabled
    t3Button = screen.getByRole('button', { name: /unlink task t3/i });
    expect(t3Button).not.toBeDisabled();

    // Mock the second load for t2's unlink completion
    fetchSpy.mockResolvedValueOnce([{ ...ITEM, task_ids: ['t3'] }] as never);

    // Resolve t2's unlink
    t2Unlink.resolve();

    // After load() completes, t2's button should disappear and t3 remains
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /unlink task t2/i })).toBeNull();
      t3Button = screen.getByRole('button', { name: /unlink task t3/i });
      expect(t3Button).not.toBeDisabled();
    });
  });

  // --- Task 15: per-project Monday scope configuration --------------------

  it('renders the Monday scope settings panel instead of the error screen when the project is unconfigured', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(
      Object.assign(new Error('no Monday scope configured for this project'), { code: 'unconfigured' }),
    );
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue([] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/configure monday scope/i)).toBeTruthy();
    // Never the error screen's banner for this specific, expected case.
    expect(screen.queryByText(/no monday scope configured/i)).toBeNull();
  });

  it('does not offer a Cancel control when there is no already-loaded view to fall back to', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(
      Object.assign(new Error('no Monday scope configured for this project'), { code: 'unconfigured' }),
    );
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue([] as never);
    render(<ProjectManagementView projectId="p1" />);
    await screen.findByText(/configure monday scope/i);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('still renders the error screen (not the config panel) for a distinct, non-unconfigured 409 like monday_disabled', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(
      Object.assign(new Error('Monday is disabled or MONDAY_TOKEN is not set'), { code: 'monday_disabled' }),
    );
    render(<ProjectManagementView projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/MONDAY_TOKEN is not set/)).toBeTruthy());
    expect(screen.queryByText(/configure monday scope/i)).toBeNull();
  });

  it('shows a Configure control once configured, and reopens the panel pre-filled with the current config', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    const getConfig = vi.spyOn(api, 'fetchMondayProjectConfig').mockResolvedValue({
      board_id: 'b1', group_id: null,
      rollup: { enabled: false, column_id: null, column_type: 'text' },
      updates: { enabled: false, min_interval_minutes: 30 },
    } as never);
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue([{ id: 'b1', name: 'Portfolio', workspace: null }] as never);

    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^configure$/i }));
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText(/configure monday scope/i)).toBeTruthy();
  });

  it('surfaces an inline error, without opening the panel, when fetching the current config for Configure fails', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    vi.spyOn(api, 'fetchMondayProjectConfig').mockRejectedValue(new Error('Failed to load config'));
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^configure$/i }));
    expect(await screen.findByText('Failed to load config')).toBeTruthy();
    // Never silently opens the panel on a blank/misleading state.
    expect(screen.queryByText(/configure monday scope/i)).toBeNull();
    // The already-loaded row must still be there too.
    expect(screen.getByText('Ship the thing')).toBeTruthy();
  });

  it('Cancel from a reopened Configure panel returns to the still-loaded items view', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    vi.spyOn(api, 'fetchMondayProjectConfig').mockResolvedValue({
      board_id: 'b1', group_id: null,
      rollup: { enabled: false, column_id: null, column_type: 'text' },
      updates: { enabled: false, min_interval_minutes: 30 },
    } as never);
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue([] as never);

    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^configure$/i }));
    await screen.findByText(/configure monday scope/i);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
  });

  it('reloads items after a successful save from the (unconfigured-triggered) config panel', async () => {
    const fetchSpy = vi.spyOn(api, 'fetchMondayItems');
    fetchSpy.mockRejectedValueOnce(
      Object.assign(new Error('no Monday scope configured for this project'), { code: 'unconfigured' }),
    );
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue([{ id: 'b1', name: 'Portfolio', workspace: null }] as never);
    const save = vi.spyOn(api, 'saveMondayProjectConfig').mockResolvedValue({} as never);
    fetchSpy.mockResolvedValueOnce([ITEM] as never);

    render(<ProjectManagementView projectId="p1" />);
    await screen.findByText(/configure monday scope/i);

    fireEvent.change(screen.getByLabelText(/^board$/i), { target: { value: 'b1' } });
    await waitFor(() => expect((screen.getByLabelText(/^board$/i) as HTMLSelectElement).value).toBe('b1'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
