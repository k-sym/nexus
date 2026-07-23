import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MondayScopeSettings } from './MondayScopeSettings';
import * as api from '../api';

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
});
