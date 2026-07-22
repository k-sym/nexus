import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MondayItemPicker } from './MondayItemPicker';
import * as api from '../api';

const ITEM = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
  name: 'Ship the thing', state: 'active' as const, status_label: null, status_color: null,
  owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
};

beforeEach(() => vi.restoreAllMocks());

describe('MondayItemPicker', () => {
  it('searches Monday live and links the chosen item', async () => {
    const search = vi.spyOn(api, 'searchMondayItems').mockResolvedValue([ITEM] as never);
    const link = vi.spyOn(api, 'linkTaskToMondayItem').mockResolvedValue(undefined as never);
    const onLinked = vi.fn();
    render(<MondayItemPicker projectId="p1" taskId="t1" currentItemId={null} onLinked={onLinked} />);

    await userEvent.type(screen.getByPlaceholderText(/search monday/i), 'ship');
    await waitFor(() => expect(search).toHaveBeenCalledWith('p1', 'ship'));
    await userEvent.click(await screen.findByText('Ship the thing'));

    await waitFor(() => expect(link).toHaveBeenCalledWith('p1', 't1', '1'));
    expect(onLinked).toHaveBeenCalled();
  });

  it('offers unlink when the task already has a link', async () => {
    const unlink = vi.spyOn(api, 'unlinkTaskFromMondayItem').mockResolvedValue(undefined as never);
    vi.spyOn(api, 'searchMondayItems').mockResolvedValue([] as never);
    const onLinked = vi.fn();
    render(<MondayItemPicker projectId="p1" taskId="t1" currentItemId="1" onLinked={onLinked} />);
    await userEvent.click(screen.getByRole('button', { name: /unlink/i }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith('t1'));
  });

  it('surfaces a search failure', async () => {
    vi.spyOn(api, 'searchMondayItems').mockRejectedValue(new Error('Not Authenticated'));
    render(<MondayItemPicker projectId="p1" taskId="t1" currentItemId={null} onLinked={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/search monday/i), 'x');
    expect(await screen.findByText(/Not Authenticated/)).toBeTruthy();
  });
});
