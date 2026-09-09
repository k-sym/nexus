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
      draft: vi.fn(),
      createSession: vi.fn(),
    },
  },
}));

vi.mock('../hooks/useModels', () => ({
  modelKey: (provider: string, id: string) => `${provider}/${id}`,
  useModels: () => ({
    models: [{ provider: 'claude-code', id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
    activeModelId: 'claude-code/claude-sonnet-5',
  }),
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
    render(<TicketsView projects={[]} onGo={vi.fn()} onOpenSession={vi.fn()} />);

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
    render(<TicketsView projects={[]} onGo={vi.fn()} onOpenSession={vi.fn()} />);

    const listPriority = await screen.findByText('Medium');
    expect(listPriority).toHaveClass('ticket-priority-pill', 'ticket-priority-medium');
    expect(listPriority).not.toHaveClass('text-amber-400');

    await user.click(screen.getByRole('button', { name: /SUP-1058/ }));

    const detailPriority = screen.getAllByText('Medium').at(-1)!;
    expect(detailPriority).toHaveClass('ticket-priority-pill', 'ticket-priority-medium');
  });

  it('drafts with Sonnet, lets the draft be edited, and calls Go with the edited values', async () => {
    vi.mocked(api.tickets.list).mockResolvedValue([ticket]);
    vi.mocked(api.tickets.description).mockResolvedValue({ key: ticket.key, body: 'Ticket body', trimmed: [], fetchedAt: null, empty: false });
    vi.mocked(api.tickets.draft).mockResolvedValue({
      key: ticket.key,
      problem: 'The last score is missing from recent reports (8AOFI).',
      projectId: 'p-wse',
      branchType: 'fix',
      branchName: 'fix/SUP1058-last-score-missing',
      model: 'claude-code/claude-sonnet-5',
    });
    const onGo = vi.fn().mockResolvedValue(undefined);
    const projects = [
      { id: 'p-nexus', name: 'Nexus', slug: 'nexus', badge: 'NX', description: '', repo_path: '/n', git_remote: '', sort_order: 0, created_at: '', updated_at: '' },
      { id: 'p-wse', name: 'WSE', slug: 'wse', badge: 'WS', description: '', repo_path: '/w', git_remote: '', sort_order: 1, created_at: '', updated_at: '' },
    ] as any;

    const user = userEvent.setup();
    render(<TicketsView projects={projects} onGo={onGo} onOpenSession={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /SUP-1058/ }));

    // Nothing to send yet: Go is disabled until there is a prompt.
    expect(screen.getByRole('button', { name: /^Go$/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Draft with Sonnet/ }));
    await waitFor(() => expect(api.tickets.draft).toHaveBeenCalledWith('SUP-1058'));

    const prompt = await screen.findByLabelText('Prompt') as HTMLTextAreaElement;
    await waitFor(() => expect(prompt.value).toMatch(/8AOFI/));
    // No pick by hand yet, so the draft's project is applied.
    expect(screen.getByRole('button', { name: 'Project' })).toHaveTextContent('WSE');
    expect(screen.queryByText(/Sonnet suggested/)).toBeNull();
    expect((screen.getByLabelText('Branch name') as HTMLInputElement).value).toBe('fix/SUP1058-last-score-missing');

    await user.type(prompt, ' Look at audit_build.php.');
    await user.click(screen.getByRole('button', { name: 'Branch type' }));
    await user.click(screen.getByRole('option', { name: 'hotfix' }));
    expect((screen.getByLabelText('Branch name') as HTMLInputElement).value).toBe('hotfix/SUP1058-last-score-missing');

    await user.click(screen.getByRole('button', { name: /^Go$/ }));
    await waitFor(() => expect(onGo).toHaveBeenCalledTimes(1));
    expect(onGo.mock.calls[0][0].key).toBe('SUP-1058');
    expect(onGo.mock.calls[0][1]).toEqual({
      projectId: 'p-wse',
      problem: 'The last score is missing from recent reports (8AOFI). Look at audit_build.php.',
      branchName: 'hotfix/SUP1058-last-score-missing',
      modelKey: 'claude-code/claude-sonnet-5',
    });
  });

  it('keeps a project picked by hand when the draft suggests another, and offers the suggestion', async () => {
    vi.mocked(api.tickets.list).mockResolvedValue([ticket]);
    vi.mocked(api.tickets.description).mockResolvedValue({ key: ticket.key, body: 'Ticket body', trimmed: [], fetchedAt: null, empty: false });
    vi.mocked(api.tickets.draft).mockResolvedValue({
      key: ticket.key,
      problem: 'Restore the division on reports.',
      projectId: 'p-wse',
      branchType: 'fix',
      branchName: 'fix/SUP1058-restore-division',
      model: 'claude-code/claude-sonnet-5',
    });
    const onGo = vi.fn().mockResolvedValue(undefined);
    const projects = [
      { id: 'p-wse', name: 'WSE', slug: 'wse', badge: 'WS', description: '', repo_path: '/w', git_remote: '', sort_order: 0, created_at: '', updated_at: '' },
      { id: 'p-ci', name: 'Wise CI', slug: 'wise-ci', badge: 'CI', description: '', repo_path: '/ci', git_remote: '', sort_order: 1, created_at: '', updated_at: '' },
    ] as any;

    const user = userEvent.setup();
    render(<TicketsView projects={projects} onGo={onGo} onOpenSession={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /SUP-1058/ }));

    // Pick Wise CI by hand, then draft: Sonnet's WSE must not replace it.
    await user.click(screen.getByRole('button', { name: 'Project' }));
    await user.click(screen.getByRole('option', { name: /Wise CI/ }));
    await user.click(screen.getByRole('button', { name: /Draft with Sonnet/ }));
    await waitFor(() => expect(api.tickets.draft).toHaveBeenCalledWith('SUP-1058'));
    await screen.findByText(/Sonnet suggested WSE/);
    expect(screen.getByRole('button', { name: 'Project' })).toHaveTextContent('Wise CI');

    await user.click(screen.getByRole('button', { name: /^Go$/ }));
    await waitFor(() => expect(onGo).toHaveBeenCalledTimes(1));
    expect(onGo.mock.calls[0][1].projectId).toBe('p-ci');

    // "Use it" adopts the suggestion and the hint goes away.
    await user.click(screen.getByRole('button', { name: 'Use it' }));
    expect(screen.getByRole('button', { name: 'Project' })).toHaveTextContent('WSE');
    expect(screen.queryByText(/Sonnet suggested/)).toBeNull();
  });

  it('shows a session badge and an Open session button for a ticket that has one', async () => {
    const withSession: Ticket = { ...ticket, session: { thread_id: 't-1', project_id: 'p-wse' } };
    vi.mocked(api.tickets.list).mockResolvedValue([withSession]);
    vi.mocked(api.tickets.description).mockResolvedValue({ key: ticket.key, body: '', trimmed: [], fetchedAt: null, empty: true });
    const onOpenSession = vi.fn();

    const user = userEvent.setup();
    render(<TicketsView projects={[]} onGo={vi.fn()} onOpenSession={onOpenSession} />);
    expect(await screen.findByTitle('Has a session')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /SUP-1058/ }));
    await user.click(await screen.findByRole('button', { name: /Open session/ }));
    expect(onOpenSession).toHaveBeenCalledWith('p-wse', 't-1');
    expect(screen.queryByRole('button', { name: /Draft with Sonnet/ })).toBeNull();
  });
});
