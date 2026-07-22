import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});
