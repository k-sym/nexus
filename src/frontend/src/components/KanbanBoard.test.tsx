import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BoardCard, BoardResponse, ChatThread } from '@nexus/shared';
import KanbanBoard from './KanbanBoard';
import * as api from '../api';

function thread(id: string, title: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    project_id: 'project-1',
    title,
    created_at: '2026-09-08T07:00:00.000Z',
    updated_at: '2026-09-08T07:00:00.000Z',
    archived_at: null,
    ...extra,
  };
}

function card(overrides: Partial<BoardCard> & Pick<BoardCard, 'thread' | 'lane' | 'origin'>): BoardCard {
  return { running: false, pending_questions: 0, pending_approvals: 0, monday_item_id: null, ...overrides };
}

/** One card per origin kind, spread across the four card lanes. */
const board: BoardResponse = {
  cards: [
    card({
      thread: thread('t-ticket', 'Scoring export fails', { ticket_key: 'SUP-1058' }),
      lane: 'running',
      origin: { kind: 'ticket', key: 'SUP-1058', url: 'https://jira.example/browse/SUP-1058' },
      running: true,
    }),
    card({
      thread: thread('t-github', 'Session-first board', { github_issue: 439 }),
      lane: 'needs_you',
      origin: { kind: 'github', number: 439, url: 'https://github.com/k-sym/nexus/issues/439' },
      running: true,
      pending_questions: 1,
      pending_approvals: 2,
    }),
    card({
      thread: thread('t-monday', 'Ship the thing'),
      lane: 'idle',
      origin: { kind: 'monday', item_id: 'm-1', name: 'Ship the thing (Monday)', url: 'https://x.monday.com/1' },
      monday_item_id: 'm-1',
    }),
    card({
      thread: thread('t-chat', 'Loose chat', { archived_at: '2026-09-08T09:00:00.000Z' }),
      lane: 'done',
      origin: { kind: 'chat' },
    }),
  ],
  inbox: [
    { kind: 'github', id: '440', title: 'Board polish', url: 'https://github.com/k-sym/nexus/issues/440', labels: ['enhancement'], status_label: null, updated: null },
    { kind: 'github', id: '441', title: 'Fix the login bug', url: 'https://github.com/k-sym/nexus/issues/441', labels: [], status_label: null, updated: null },
    { kind: 'monday', id: 'm-2', title: 'Quarterly roadmap', url: 'https://x.monday.com/2', labels: [], status_label: 'Working on it', updated: null },
  ],
  inbox_errors: {},
};

const noop = () => {};

function renderBoard(props: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
  return render(
    <KanbanBoard
      board={board}
      projectId="project-1"
      onOpenThread={noop}
      onOpenInboxItem={noop}
      onNewIdea={noop}
      onOpenDiffReview={noop}
      {...props}
    />,
  );
}

const lane = (id: string) => document.querySelector(`[data-lane-column="${id}"]`) as HTMLElement;

describe('KanbanBoard (session-first, #439)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue(null);
  });

  it('renders the five lanes in order with every card in its derived lane', () => {
    renderBoard();

    const headers = Array.from(document.querySelectorAll('[data-lane-column]'))
      .map((col) => col.querySelector('span')?.textContent);
    expect(headers).toEqual(['Inbox', 'Running', 'Needs you', 'Idle', 'Done']);

    expect(within(lane('running')).getByText('Scoring export fails')).toBeInTheDocument();
    expect(within(lane('needs_you')).getByText('Session-first board')).toBeInTheDocument();
    expect(within(lane('idle')).getByText('Ship the thing')).toBeInTheDocument();
    expect(within(lane('done')).getByText('Loose chat')).toBeInTheDocument();
    expect(lane('running')).toHaveTextContent('1');
  });

  it('badges each card with its origin: ticket key, #issue, Monday item name, nothing for chat', () => {
    renderBoard();

    expect(screen.getByText('SUP-1058')).toHaveAttribute('data-origin', 'ticket');
    expect(screen.getByText('#439')).toHaveAttribute('data-origin', 'github');
    expect(screen.getByText('Ship the thing (Monday)')).toHaveAttribute('data-origin', 'monday');
    const chatCard = screen.getByText('Loose chat').closest('[data-kanban-card]') as HTMLElement;
    expect(chatCard.querySelector('[data-origin]')).toBeNull();
  });

  it('marks running cards with a pulsing dot and Needs-you cards with their counts', () => {
    renderBoard();

    const running = screen.getByText('Scoring export fails').closest('[data-kanban-card]') as HTMLElement;
    expect(within(running).getByLabelText('Running')).toHaveClass('animate-pulse');

    const needsYou = screen.getByText('Session-first board').closest('[data-kanban-card]') as HTMLElement;
    expect(within(needsYou).getByText(/Needs you/)).toBeInTheDocument();
    expect(needsYou).toHaveTextContent('1 question');
    expect(needsYou).toHaveTextContent('2 approvals');

    const idle = screen.getByText('Ship the thing').closest('[data-kanban-card]') as HTMLElement;
    expect(within(idle).queryByLabelText('Running')).toBeNull();
    expect(idle).not.toHaveTextContent('Needs you');
  });

  it('lists Inbox rows with a kind badge and narrows them through the filter', () => {
    renderBoard();

    const inbox = lane('inbox');
    expect(within(inbox).getByText('GH #440')).toBeInTheDocument();
    expect(within(inbox).getByText('GH #441')).toBeInTheDocument();
    expect(within(inbox).getByText('Monday')).toBeInTheDocument();
    expect(within(inbox).getByText('enhancement')).toBeInTheDocument();
    expect(within(inbox).getByText('Working on it')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter inbox'), { target: { value: 'LOGIN' } });
    expect(within(inbox).getByText('Fix the login bug')).toBeInTheDocument();
    expect(within(inbox).queryByText('Board polish')).toBeNull();
    expect(within(inbox).queryByText('Quarterly roadmap')).toBeNull();
    // The header count is the whole Inbox, not the filtered view.
    expect(within(inbox).getByText('3')).toBeInTheDocument();

    // Matches on the id too.
    fireEvent.change(screen.getByLabelText('Filter inbox'), { target: { value: '440' } });
    expect(within(inbox).getByText('Board polish')).toBeInTheDocument();
    expect(within(inbox).queryByText('Fix the login bug')).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter inbox'), { target: { value: 'zzz' } });
    expect(within(inbox).getByText('Nothing here')).toBeInTheDocument();
  });

  it('opens the thread on card click and the origin panel on an Inbox click', () => {
    const onOpenThread = vi.fn();
    const onOpenInboxItem = vi.fn();
    renderBoard({ onOpenThread, onOpenInboxItem, selectedInboxKey: 'monday:m-2' });

    fireEvent.click(screen.getByText('Ship the thing'));
    expect(onOpenThread).toHaveBeenCalledWith('t-monday');

    fireEvent.click(screen.getByText('Board polish'));
    expect(onOpenInboxItem).toHaveBeenCalledWith(board.inbox[0]);

    // The selected row reads as pressed; the others do not.
    expect(screen.getByText('Quarterly roadmap').closest('button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Board polish').closest('button')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows one "+" — on the Inbox — that files a new idea (D14)', () => {
    const onNewIdea = vi.fn();
    renderBoard({ onNewIdea });

    const plus = screen.getAllByRole('button', { name: 'New idea' });
    expect(plus).toHaveLength(1);
    expect(lane('inbox')).toContainElement(plus[0]);
    fireEvent.click(plus[0]);
    expect(onNewIdea).toHaveBeenCalled();
  });

  it('has no drag-and-drop: lanes are derived, not moved', () => {
    renderBoard();
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(document.querySelectorAll('[draggable]')).toHaveLength(0);
  });

  it('offers Diff on Idle and Running cards only, with the card as the argument', () => {
    const onOpenDiffReview = vi.fn();
    renderBoard({ onOpenDiffReview });

    const diffButtons = screen.getAllByRole('button', { name: 'Diff' });
    expect(diffButtons).toHaveLength(2);
    expect(lane('running')).toContainElement(diffButtons[0]);
    expect(lane('idle')).toContainElement(diffButtons[1]);
    expect(within(lane('needs_you')).queryByRole('button', { name: 'Diff' })).toBeNull();
    expect(within(lane('done')).queryByRole('button', { name: 'Diff' })).toBeNull();

    fireEvent.click(diffButtons[1]);
    expect(onOpenDiffReview).toHaveBeenCalledWith(board.cards[2]);
  });

  it('surfaces feed failures as an amber line per feed and still renders cards', () => {
    renderBoard({ board: { ...board, inbox: [], inbox_errors: { github: 'rate limited', monday: 'token expired' } } });

    expect(screen.getByText('GitHub: rate limited')).toHaveClass('text-amber-400');
    expect(screen.getByText('Monday: token expired')).toHaveClass('text-amber-400');
    expect(screen.getByText('Scoring export fails')).toBeInTheDocument();
  });

  it('shows "Nothing here" in an empty lane and the thread model when the thread carries one', () => {
    const withModel: BoardResponse = {
      cards: [card({
        thread: { ...thread('t-x', 'Modelled'), last_model_key: 'anthropic/claude-opus-5' } as ChatThread,
        lane: 'idle',
        origin: { kind: 'chat' },
      })],
      inbox: [],
      inbox_errors: {},
    };
    renderBoard({ board: withModel });

    expect(screen.getAllByText('Nothing here')).toHaveLength(4);
    expect(screen.getByText('claude-opus-5')).toBeInTheDocument();
  });

  it('renders the Monday badge for a linked card from the project item map, keyed by thread id', async () => {
    const fetchMondayItems = vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([{
      item_id: 'm-1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
      name: 'Ship the thing (Monday)', state: 'active', status_label: null, status_color: null,
      owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
      rollup: { total: 1, open: 0, inProgress: 0, inReview: 1, done: 0 }, rollup_text: '0/1 done',
      thread_ids: ['t-monday'],
    }]);
    renderBoard();

    await waitFor(() => expect(fetchMondayItems).toHaveBeenCalledWith('project-1'));
    const idle = screen.getByText('Ship the thing').closest('[data-kanban-card]') as HTMLElement;
    await waitFor(() => expect(within(idle).getByTitle('Ship the thing (Monday)')).toHaveClass('bg-sky-500/15'));
  });

  it('keeps the board usable when the Monday badge fetch rejects (e.g. an expired token)', async () => {
    const fetchMondayItems = vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(new Error('Monday token expired'));
    const onOpenThread = vi.fn();
    renderBoard({ onOpenThread });

    await waitFor(() => expect(fetchMondayItems).toHaveBeenCalledWith('project-1'));
    expect(screen.queryByText(/monday token expired/i)).toBeNull();
    fireEvent.click(screen.getByText('Loose chat'));
    expect(onOpenThread).toHaveBeenCalledWith('t-chat');
  });

  it('keeps the ambient lane and card classes', () => {
    renderBoard();
    const title = screen.getByText('Scoring export fails');
    expect(title.closest('[data-kanban-lane]')).toHaveClass('kanban-lane');
    expect(title.closest('[data-kanban-card]')).toHaveClass('kanban-card');
  });
});
