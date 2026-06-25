import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Ticket } from '@nexus/shared';
import { api } from '../api';
import TicketsView from './TicketsView';

vi.mock('../api', () => ({
  api: {
    tickets: {
      list: vi.fn(),
      description: vi.fn(),
    },
  },
}));

const ticket: Ticket = {
  key: 'SUP-1058',
  summary: 'FW: Scoring',
  status: 'Waiting for support',
  priority: 'Medium',
  assignee: 'Kay',
  created: '2026-06-25T09:00:00.000Z',
  updated: '2026-06-25T10:00:00.000Z',
  url: 'https://jira.example/browse/SUP-1058',
  source: 'jira',
  synced_at: '2026-06-25T10:05:00.000Z',
};

describe('TicketsView', () => {
  it('uses the current accent styling for Jira ticket links', async () => {
    vi.mocked(api.tickets.list).mockResolvedValue([ticket]);
    vi.mocked(api.tickets.description).mockResolvedValue({
      key: ticket.key,
      body: 'Ticket body',
      trimmed: [],
      fetchedAt: '2026-06-25T10:05:00.000Z',
      empty: false,
    });

    const user = userEvent.setup();
    render(<TicketsView projects={[]} onCreateTask={vi.fn()} />);

    const listKey = await screen.findByText('SUP-1058');
    expect(listKey).toHaveClass('accent-text');
    expect(listKey).not.toHaveClass('text-indigo-400/80');

    await user.click(screen.getByRole('button', { name: /SUP-1058/ }));
    await waitFor(() => expect(api.tickets.description).toHaveBeenCalledWith('SUP-1058', false));

    const detailKey = screen.getAllByText('SUP-1058').at(-1)!;
    expect(detailKey).toHaveClass('accent-text');

    const jiraLink = screen.getByRole('link', { name: /Open in Jira/ });
    expect(jiraLink).toHaveClass('accent-text');
    expect(jiraLink).not.toHaveClass('text-indigo-400');
  });

  it('renders medium priority as an inverted status pill', async () => {
    vi.mocked(api.tickets.list).mockResolvedValue([ticket]);
    vi.mocked(api.tickets.description).mockResolvedValue({
      key: ticket.key,
      body: 'Ticket body',
      trimmed: [],
      fetchedAt: '2026-06-25T10:05:00.000Z',
      empty: false,
    });

    const user = userEvent.setup();
    render(<TicketsView projects={[]} onCreateTask={vi.fn()} />);

    const listPriority = await screen.findByText('Medium');
    expect(listPriority).toHaveClass('ticket-priority-pill', 'ticket-priority-medium');
    expect(listPriority).not.toHaveClass('text-amber-400');

    await user.click(screen.getByRole('button', { name: /SUP-1058/ }));

    const detailPriority = screen.getAllByText('Medium').at(-1)!;
    expect(detailPriority).toHaveClass('ticket-priority-pill', 'ticket-priority-medium');
  });
});
