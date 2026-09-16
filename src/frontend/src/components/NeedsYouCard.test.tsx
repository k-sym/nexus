import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NeedsYouCard, { offeredVerbs } from './NeedsYouCard';
import { api, AttentionItem } from '../api';

// The card acts on the partner's items, so most of this is about what it must
// NOT do: offer a verb the item does not list, offer any verb in a state the
// partner refuses, or let a refused verb look like one that worked (#477).
const NOW = Math.floor(Date.now() / 1000);

const MAIL: AttentionItem = {
  id: 'att_mail',
  kind: 'mail.waiting',
  status: 'open',
  title: 'Re: Method statement for the Colchester refit',
  why: 'waiting 3.2d from jane.holloway@contractor-example.co.uk',
  body: null,
  source: { account: 'ssuk' },
  links: { draft_id: null, vault_page: null, proposal_id: null },
  proposed_verb: 'draft',
  verbs: ['draft', 'open', 'snooze', 'dismiss'],
  lens_verbs: ['draft', 'snooze', 'dismiss'],
  producer: 'inbox-nudge',
  created_at: NOW - 3600 * 5,
  updated_at: NOW - 3600,
  snoozed_until: null,
  expires_at: NOW + 86400,
  seq: 12,
  alert_seq: 4,
  resolution: null,
};

const FUTURE: AttentionItem = {
  ...MAIL,
  id: 'att_future',
  kind: 'future.kind',
  title: 'Something a newer producer posted',
  why: 'unknown kind and verb',
  proposed_verb: 'teleport',
  verbs: ['teleport', 'snooze', 'dismiss'],
};

const RESOLVED: AttentionItem = {
  ...MAIL,
  id: 'att_done',
  status: 'resolved',
  title: 'Already dismissed',
  resolution: { verb: 'dismiss', by: 'ios', surface: 'phone', at: NOW - 60, result: null },
};

function stubList(items = [MAIL]) {
  vi.spyOn(api.attention, 'list').mockResolvedValue({
    configured: true, items, open: items.filter((i) => i.status === 'open').length, seq: 12, alert_seq: 4,
  });
  vi.spyOn(api.attention, 'get').mockImplementation(async (id) => ({ ...items.find((i) => i.id === id)!, events: [] }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('offeredVerbs', () => {
  it('lists the known verbs in canonical order, only while open or snoozed', () => {
    expect(offeredVerbs(MAIL)).toEqual(['draft', 'open', 'snooze', 'dismiss']);
    expect(offeredVerbs({ ...MAIL, status: 'snoozed', verbs: ['dismiss', 'open', 'snooze'] })).toEqual(['open', 'snooze', 'dismiss']);
    expect(offeredVerbs(FUTURE)).toEqual(['snooze', 'dismiss']);
    expect(offeredVerbs(RESOLVED)).toEqual([]);
    expect(offeredVerbs({ ...MAIL, status: 'resolving' })).toEqual([]);
  });
});

describe('NeedsYouCard', () => {
  it('stays out of the way when nothing needs you, when unconfigured, and when the route is missing', async () => {
    stubList([]);
    const { container, unmount } = render(<NeedsYouCard />);
    await waitFor(() => expect(api.attention.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();

    vi.spyOn(api.attention, 'list').mockResolvedValue({ configured: false, items: [], open: 0, seq: 0, alert_seq: 0 });
    const second = render(<NeedsYouCard />);
    await waitFor(() => expect(api.attention.list).toHaveBeenCalled());
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();

    vi.spyOn(api.attention, 'list').mockRejectedValue(new Error('Route GET:/api/attention not found'));
    const third = render(<NeedsYouCard />);
    await waitFor(() => expect(api.attention.list).toHaveBeenCalled());
    expect(third.container).toBeEmptyDOMElement();
  });

  it('lists items with the proposed verb, and shows the partner outage as text, not as rows', async () => {
    stubList([MAIL, FUTURE]);
    render(<NeedsYouCard />);
    await screen.findByText(/Colchester refit/);
    expect(screen.getByText('Draft?')).toBeInTheDocument();
    // An unknown proposed verb shows the kind instead of inventing a button.
    expect(screen.getByText('future.kind')).toBeInTheDocument();
    expect(screen.getByText('2 open')).toBeInTheDocument();
  });

  it('renders exactly the verbs the item lists, gated on status, once expanded', async () => {
    stubList([MAIL, FUTURE, RESOLVED]);
    const user = userEvent.setup();
    render(<NeedsYouCard />);
    await screen.findByText(/Colchester refit/);
    // Collapsed: nothing to press.
    expect(screen.queryByRole('button', { name: 'Draft a reply' })).not.toBeInTheDocument();

    await user.click(screen.getByText(/Colchester refit/));
    expect(await screen.findByRole('button', { name: 'Draft a reply' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Snooze…' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    // Never an approve or send, whatever the payload says.
    expect(screen.queryByRole('button', { name: /send|approve/i })).not.toBeInTheDocument();

    await user.click(screen.getByText(/newer producer/));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /teleport/i })).not.toBeInTheDocument();

    await user.click(screen.getByText(/Already dismissed/));
    await screen.findByText(/ios from phone/);
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2); // the resolved row adds none
  });

  it('dismiss resolves as web/desktop and refreshes the list; a refusal stays on the row', async () => {
    stubList();
    const resolve = vi.spyOn(api.attention, 'resolve').mockResolvedValue({
      ...MAIL, status: 'resolved', resolution: { verb: 'dismiss', by: 'web', surface: 'desktop', at: NOW, result: null },
    });
    const user = userEvent.setup();
    render(<NeedsYouCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('att_mail', { verb: 'dismiss' }));
    expect(await screen.findByText(/web from desktop/)).toBeVisible();
    expect(api.attention.list).toHaveBeenCalledTimes(2);

    resolve.mockRejectedValueOnce(new Error('item is resolved'));
  });

  it('a verb the partner refuses says so and offers the verbs again', async () => {
    stubList();
    vi.spyOn(api.attention, 'resolve').mockRejectedValue(new Error('item is resolved'));
    const user = userEvent.setup();
    render(<NeedsYouCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('item is resolved')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  });

  it('snooze asks which preset and sends it', async () => {
    stubList();
    const resolve = vi.spyOn(api.attention, 'resolve').mockResolvedValue({ ...MAIL, status: 'snoozed', snoozed_until: NOW + 72000 });
    const user = userEvent.setup();
    render(<NeedsYouCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Snooze…' }));
    expect(resolve).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'tomorrow' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('att_mail', { verb: 'snooze', preset: 'tomorrow' }));
    expect(await screen.findByText(/snoozed until/)).toBeVisible();
  });

  it('draft shows a drafting state and polls the detail until the item settles, then points at Drafts', async () => {
    stubList();
    vi.spyOn(api.attention, 'resolve').mockResolvedValue({ ...MAIL, status: 'resolving' });
    const get = vi.spyOn(api.attention, 'get')
      .mockResolvedValueOnce({ ...MAIL, events: [] })                 // expand
      .mockResolvedValueOnce({ ...MAIL, status: 'resolving' })        // poll 1
      .mockResolvedValueOnce({                                        // poll 2
        ...MAIL, status: 'resolved',
        links: { ...MAIL.links, draft_id: '216ef299e734' },
        resolution: { verb: 'draft', by: 'web', surface: 'desktop', at: NOW, result: { draft_id: '216ef299e734' } },
      });
    const user = userEvent.setup();
    render(<NeedsYouCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Draft a reply' }));
    expect(await screen.findByText(/Drafting… the partner is writing a reply/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    await waitFor(() => expect(get).toHaveBeenCalledTimes(3), { timeout: 8000 });
    expect(await screen.findByText(/Draft a reply · web from desktop/)).toBeVisible();
    expect(screen.getByText(/the draft is in "Drafts awaiting you" below/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Draft a reply' })).not.toBeInTheDocument();
  }, 10_000);

  it('open on a pending draft points at the Drafts card and records the event', async () => {
    const pending: AttentionItem = { ...MAIL, id: 'att_draft', kind: 'draft.pending', proposed_verb: 'open', verbs: ['open', 'snooze', 'dismiss'], links: { draft_id: '216ef299e734', vault_page: null, proposal_id: null } };
    stubList([pending]);
    const resolve = vi.spyOn(api.attention, 'resolve').mockResolvedValue(pending);
    const user = userEvent.setup();
    render(<NeedsYouCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Review it in "Drafts awaiting you" below/)).toBeVisible();
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('att_draft', { verb: 'open' }));
  });
});
