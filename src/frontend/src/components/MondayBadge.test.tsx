import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MondayBadge } from './MondayBadge';
import type { MondayItem } from '@nexus/shared';

const ITEM: MondayItem = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
  name: 'Ship the thing', state: 'active', status_label: null, status_color: null,
  owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
};

describe('MondayBadge', () => {
  it('renders the item name for an active item, without the unavailable styling', () => {
    render(<MondayBadge item={ITEM} />);
    const badge = screen.getByText('Ship the thing');
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('bg-sky-500/15');
    expect(badge.className).not.toContain('bg-amber-500/15');
    expect(badge.title).toBe('Ship the thing');
  });

  it('distinguishes a missing item with amber styling and an explanatory title', () => {
    render(<MondayBadge item={{ ...ITEM, state: 'missing' }} />);
    const badge = screen.getByText('Ship the thing');
    expect(badge.className).toContain('bg-amber-500/15');
    expect(badge.className).not.toContain('bg-sky-500/15');
    expect(badge.title).toBe('Ship the thing — no longer in Monday');
  });

  it('renders nothing when there is no linked item', () => {
    const { container } = render(<MondayBadge item={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('distinguishes an archived item with amber styling and an explanatory title', () => {
    render(<MondayBadge item={{ ...ITEM, state: 'archived' }} />);
    const badge = screen.getByText('Ship the thing');
    expect(badge.className).toContain('bg-amber-500/15');
    expect(badge.className).not.toContain('bg-sky-500/15');
    expect(badge.title).toBe('Ship the thing — archived in Monday');
  });

  it('distinguishes a deleted item with amber styling and an explanatory title', () => {
    render(<MondayBadge item={{ ...ITEM, state: 'deleted' }} />);
    const badge = screen.getByText('Ship the thing');
    expect(badge.className).toContain('bg-amber-500/15');
    expect(badge.className).not.toContain('bg-sky-500/15');
    expect(badge.title).toBe('Ship the thing — deleted in Monday');
  });
});
