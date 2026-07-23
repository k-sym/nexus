import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MondayScopeSettings } from './MondayScopeSettings';
import * as api from '../api';
import type { MondayProjectConfig } from '@nexus/shared';

/** A promise whose resolution is controlled by the caller, so tests can force
 *  a specific settle order for concurrent requests. Same helper as
 *  ProjectManagementView.test.tsx. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const BOARDS = [
  { id: 'b1', name: 'Portfolio', workspace: 'Product' },
  { id: 'b2', name: 'Ops', workspace: null },
];

// The trap this whole field exists to prevent: an id-sniffing implementation
// would read "text_1" as text and "numbers_9" as numeric — exactly backwards
// from what's asserted below, since Monday's reported `type` disagrees with
// each column's id.
const META = {
  groups: [{ id: 'g1', title: 'Q3' }, { id: 'g2', title: 'Q4' }],
  columns: [
    { id: 'text_1', title: 'Points', type: 'numbers' },
    { id: 'numbers_9', title: 'Notes', type: 'text' },
  ],
};

const CURRENT_CONFIG = {
  board_id: 'b1',
  group_id: 'g1',
  rollup: { enabled: true, column_id: 'text_1', column_type: 'numeric' as const },
  updates: { enabled: true, min_interval_minutes: 45 },
};

beforeEach(() => vi.restoreAllMocks());

describe('MondayScopeSettings', () => {
  it('loads and renders the board list', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    expect(await screen.findByText(/Portfolio/)).toBeTruthy();
    expect(screen.getByText(/Ops/)).toBeTruthy();
  });

  it('shows an error, never an empty picker, when loading boards fails', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockRejectedValue(new Error('Not Authenticated'));
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    expect(await screen.findByText(/Not Authenticated/)).toBeTruthy();
    expect(screen.queryByLabelText(/^board$/i)).toBeNull();
  });

  it('loads groups and columns after selecting a board', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    const metaSpy = vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await screen.findByText(/Portfolio/);

    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), 'b1');
    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith('b1'));
    expect(await screen.findByText('Q3')).toBeTruthy();
    expect(screen.getByText(/Points/)).toBeTruthy();
  });

  it('offers an explicit "whole board" choice rather than leaving the group blank', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    expect(screen.getByText(/whole board/i)).toBeTruthy();
  });

  it("derives column_type 'numeric' from the column's reported type even though its id says text", async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const save = vi.spyOn(api, 'saveMondayProjectConfig').mockResolvedValue({} as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));
    await userEvent.selectOptions(screen.getByLabelText(/roll-up column/i), 'text_1');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const [, payload] = save.mock.calls[0] as [string, any];
    expect(payload.rollup.column_id).toBe('text_1');
    expect(payload.rollup.column_type).toBe('numeric');
  });

  it("derives column_type 'text' from the column's reported type even though its id says numbers", async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const save = vi.spyOn(api, 'saveMondayProjectConfig').mockResolvedValue({} as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));
    await userEvent.selectOptions(screen.getByLabelText(/roll-up column/i), 'numbers_9');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const [, payload] = save.mock.calls[0] as [string, any];
    expect(payload.rollup.column_id).toBe('numbers_9');
    expect(payload.rollup.column_type).toBe('text');
  });

  it('disables the roll-up column picker while the toggle is off', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    expect(screen.getByLabelText(/roll-up column/i)).toBeDisabled();
  });

  it('disables the update interval input while the updates toggle is off', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await screen.findByText(/Portfolio/);
    expect(screen.getByLabelText(/update interval/i)).toBeDisabled();
  });

  it('disables Save until a board is selected', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await screen.findByText(/Portfolio/);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('disables Save when the roll-up is on but no column is chosen', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('posts the expected payload on save (whole board, no roll-up, no updates)', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const save = vi.spyOn(api, 'saveMondayProjectConfig').mockResolvedValue({} as never);
    const onSaved = vi.fn();
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={onSaved} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith('p1', {
      board_id: 'b1',
      group_id: null,
      rollup: { enabled: false, column_id: null, column_type: 'text' },
      updates: { enabled: false, min_interval_minutes: 30 },
    }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('surfaces a save failure instead of silently succeeding', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const onSaved = vi.fn();
    vi.spyOn(api, 'saveMondayProjectConfig').mockRejectedValue(new Error('board_id is required'));
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={onSaved} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/board_id is required/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('pre-fills from the current config and loads its board\'s metadata', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    const metaSpy = vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    render(<MondayScopeSettings projectId="p1" current={CURRENT_CONFIG as never} onSaved={vi.fn()} />);

    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith('b1'));
    await screen.findByText('Q3');
    expect((screen.getByLabelText(/^board$/i) as HTMLSelectElement).value).toBe('b1');
    expect((screen.getByLabelText(/roll-up column/i) as HTMLSelectElement).value).toBe('text_1');
    expect((screen.getByLabelText(/update interval/i) as HTMLInputElement).value).toBe('45');
  });

  it('renders a Cancel control when onCancel is provided, and calls it', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    const onCancel = vi.fn();
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} onCancel={onCancel} />);
    await screen.findByText(/Portfolio/);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  // --- Finding 2: an emptied interval field must never produce an invalid save ---

  it('disables Save once the update interval is cleared while the updates toggle is on', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await userEvent.click(screen.getByLabelText(/post progress/i));
    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();

    const interval = screen.getByLabelText(/update interval/i);
    await userEvent.clear(interval);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('disables Save when the update interval is 0 while the updates toggle is on', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await userEvent.click(screen.getByLabelText(/post progress/i));

    const interval = screen.getByLabelText(/update interval/i);
    await userEvent.clear(interval);
    await userEvent.type(interval, '0');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  // --- Finding 3: the 5-minute server floor is visible, and the panel adopts
  // the canonical config the PUT actually stored -------------------------

  it('sets the interval input minimum to the server floor and states it', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await screen.findByText(/Portfolio/);
    const interval = screen.getByLabelText(/update interval/i) as HTMLInputElement;
    expect(interval.min).toBe('5');
    expect(screen.getByText(/minimum 5/i)).toBeTruthy();
  });

  it('adopts the clamped, canonical config the PUT returns instead of the raw value the user typed', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const clamped: MondayProjectConfig = {
      board_id: 'b1',
      group_id: null,
      rollup: { enabled: false, column_id: null, column_type: 'text' },
      updates: { enabled: true, min_interval_minutes: 5 },
    };
    vi.spyOn(api, 'saveMondayProjectConfig').mockResolvedValue(clamped);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByLabelText(/post progress/i));
    const interval = screen.getByLabelText(/update interval/i);
    await userEvent.clear(interval);
    await userEvent.type(interval, '2'); // below the floor but positive — a valid client-side save

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect((screen.getByLabelText(/update interval/i) as HTMLInputElement).value).toBe('5'));
  });

  // --- Finding 6: changing the board resets the roll-up column's type, not
  // just its id ------------------------------------------------------------

  it('resets the stale roll-up column_type, not just the column_id, when the board changes', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    const metaSpy = vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const save = vi.spyOn(api, 'saveMondayProjectConfig').mockResolvedValue({} as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));
    // 'text_1' reports Monday type "numbers" in META, so this derives 'numeric'.
    await userEvent.selectOptions(screen.getByLabelText(/roll-up column/i), 'text_1');

    // Switch boards — this must reset column_id (already did) AND column_type.
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), 'b2');
    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith('b2'));
    await screen.findByText('Q3');

    // Turn roll-up back off (no column has been picked on the new board, so
    // Save would otherwise stay disabled) to observe the payload.
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const [, payload] = save.mock.calls[0] as [string, any];
    expect(payload.rollup.column_id).toBe(null);
    // Before the fix this stayed 'numeric', a leftover from board b1's
    // now-abandoned column selection.
    expect(payload.rollup.column_type).toBe('text');
  });

  // --- Finding 7: the roll-up column picker explains why it is empty -----

  it('disables the roll-up column picker with a placeholder before any board is chosen', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await screen.findByText(/Portfolio/);
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));

    const select = screen.getByLabelText(/roll-up column/i);
    expect(select).toBeDisabled();
    expect(screen.getByText(/select a board first/i)).toBeTruthy();
  });

  it('disables the roll-up column picker with a placeholder after board metadata fails to load', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockRejectedValue(new Error('Not Authenticated'));
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText(/Not Authenticated/);
    await userEvent.click(screen.getByLabelText(/write task roll-up/i));

    const select = screen.getByLabelText(/roll-up column/i);
    expect(select).toBeDisabled();
    expect(screen.getByText(/columns unavailable/i)).toBeTruthy();
  });

  // --- Finding 8: untested behaviours -------------------------------------

  it('shows board B\'s metadata (not stale board A metadata) when A resolves last', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    const forA = deferred<api.MondayBoardMetaResult>();
    const forB = deferred<api.MondayBoardMetaResult>();
    const metaSpy = vi.spyOn(api, 'fetchMondayBoardMeta').mockImplementation(async (id: string) => (
      id === 'b1' ? forA.promise : forB.promise
    ));
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);
    await screen.findByText(/Portfolio/);

    // Select board A, then board B while A's request is still in flight.
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), 'b1');
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), 'b2');
    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith('b2'));

    // B (the newer request) resolves first.
    forB.resolve({ groups: [{ id: 'gB', title: 'B-Group' }], columns: [{ id: 'colB', title: 'ColB', type: 'text' }] });
    await screen.findByText('B-Group');

    // A (the stale, older request) resolves last — it must never win.
    forA.resolve(META);
    await waitFor(() => expect(screen.getByText('B-Group')).toBeTruthy());
    expect(screen.queryByText('Q3')).toBeNull();
  });

  it('disables Save while a save is in flight', async () => {
    vi.spyOn(api, 'fetchMondayBoards').mockResolvedValue(BOARDS as never);
    vi.spyOn(api, 'fetchMondayBoardMeta').mockResolvedValue(META as never);
    const saveDeferred = deferred<MondayProjectConfig>();
    vi.spyOn(api, 'saveMondayProjectConfig').mockReturnValue(saveDeferred.promise);
    render(<MondayScopeSettings projectId="p1" current={null} onSaved={vi.fn()} />);

    await userEvent.selectOptions(await screen.findByLabelText(/^board$/i), 'b1');
    await screen.findByText('Q3');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();

    saveDeferred.resolve({
      board_id: 'b1', group_id: null,
      rollup: { enabled: false, column_id: null, column_type: 'text' },
      updates: { enabled: false, min_interval_minutes: 30 },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled());
  });
});
