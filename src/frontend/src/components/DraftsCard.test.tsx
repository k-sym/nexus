import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DraftsCard from './DraftsCard';
import { api } from '../api';

// This card sends email. The tests below are mostly about what it must NOT do:
// send from a collapsed row, send on one click, or let a failed send look like
// a successful one (baker-internal#42).
const DRAFT = {
  id: 'd1',
  account: 'ssuk',
  status: 'pending' as const,
  subject: 'Re: Method statement for the Colchester refit',
  to: [],
  cc: [],
  reply_to: 'ssuk:AAMkAG1',
  thread: 'AAQkAG1',
  source: 'draft-replies',
  rationale: 'waiting 3.2d from jane.holloway@contractor-example.co.uk',
  preview: 'Hi Jane, thanks for the chase…',
  body_chars: 284,
};

const DETAIL = { ...DRAFT, body: 'Hi Jane,\n\nThursday works.\n\nKeith', sendable: false, sendable_reason: 'not approved (status=pending)' };
const EDITED_DETAIL = { ...DETAIL, body: 'Hi Jane,\n\nFriday actually.\n\nKeith', edited: true };

function stubQueue(drafts = [DRAFT]) {
  vi.spyOn(api.drafts, 'list').mockResolvedValue({ configured: true, drafts, pending: drafts.length });
  vi.spyOn(api.drafts, 'get').mockResolvedValue(DETAIL);
}

afterEach(() => vi.restoreAllMocks());

describe('DraftsCard', () => {
  it('stays out of the way when nothing is waiting', async () => {
    stubQueue([]);
    const { container } = render(<DraftsCard />);
    await waitFor(() => expect(api.drafts.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists a pending draft and only reveals actions once the body is shown', async () => {
    stubQueue();
    const user = userEvent.setup();
    render(<DraftsCard />);
    await screen.findByText(/Colchester refit/);
    // Collapsed: no way to send something you have not read.
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();

    await user.click(screen.getByText(/Colchester refit/));
    await screen.findByText(/Thursday works/);
    expect(screen.getByRole('button', { name: 'Send…' })).toBeVisible();
  });

  it('requires a second, explicit confirmation before sending', async () => {
    stubQueue();
    const approve = vi.spyOn(api.drafts, 'approve').mockResolvedValue({ ...DRAFT, status: 'sent', sent: true });
    const user = userEvent.setup();
    render(<DraftsCard />);

    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Send…' }));
    // First click only arms it.
    expect(approve).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm send' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText('Sent.')).toBeVisible();
  });

  it('arming the send can be cancelled without sending', async () => {
    stubQueue();
    const approve = vi.spyOn(api.drafts, 'approve');
    const user = userEvent.setup();
    render(<DraftsCard />);

    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Send…' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send…' })).toBeVisible();
  });

  it('a failed send says so and never claims it was sent', async () => {
    stubQueue();
    vi.spyOn(api.drafts, 'approve').mockRejectedValue(
      new Error('refusing to send draft d1: content changed after approval'),
    );
    const user = userEvent.setup();
    render(<DraftsCard />);

    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Send…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm send' }));

    expect(await screen.findByText(/content changed after approval/)).toBeVisible();
    expect(screen.queryByText('Sent.')).not.toBeInTheDocument();
  });

  it('rejecting closes the draft without sending', async () => {
    stubQueue();
    const approve = vi.spyOn(api.drafts, 'approve');
    const reject = vi.spyOn(api.drafts, 'reject').mockResolvedValue({ ...DRAFT, status: 'rejected' });
    const user = userEvent.setup();
    render(<DraftsCard />);

    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reject).toHaveBeenCalledWith('d1'));
    expect(approve).not.toHaveBeenCalled();
    expect(await screen.findByText(/Rejected/)).toBeVisible();
  });
});


describe('DraftsCard editing (#97)', () => {
  it('hides Send entirely while the textarea holds unsaved text', async () => {
    stubQueue();
    const user = userEvent.setup();
    render(<DraftsCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await screen.findByText(/Thursday works/);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    // The stale-text guard: nothing on screen can send while editing.
    expect(screen.getByRole('textbox', { name: 'Edit draft body' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('Save round-trips through the API and Send only then returns', async () => {
    stubQueue();
    const edit = vi.spyOn(api.drafts, 'edit').mockResolvedValue(EDITED_DETAIL);
    const user = userEvent.setup();
    render(<DraftsCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit draft body' });
    await user.clear(box);
    await user.type(box, 'Hi Jane, Friday actually. Keith');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(edit).toHaveBeenCalledWith('d1', 'Hi Jane, Friday actually. Keith'));
    // Back in read mode: the SAVED body renders, Send is reachable again, and
    // the weaker ledger outcome is signposted.
    expect(await screen.findByText(/Friday actually/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send…' })).toBeVisible();
    expect(screen.getByText(/approved-with-edits/)).toBeVisible();
  });

  it('Discard changes reverts without calling the API', async () => {
    stubQueue();
    const edit = vi.spyOn(api.drafts, 'edit');
    const user = userEvent.setup();
    render(<DraftsCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(edit).not.toHaveBeenCalled();
    expect(await screen.findByText(/Thursday works/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send…' })).toBeVisible();
  });

  it('a failed save stays in edit mode and says so', async () => {
    stubQueue();
    vi.spyOn(api.drafts, 'edit').mockRejectedValue(
      new Error("cannot edit a draft in state 'sent' — a sent draft is history, not a document"));
    const user = userEvent.setup();
    render(<DraftsCard />);
    await user.click(await screen.findByText(/Colchester refit/));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/history, not a document/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Edit draft body' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
  });
});


describe('DraftsCard meetings (#43)', () => {
  const MEETING = {
    id: 'm1',
    kind: 'meeting' as const,
    account: 'ssuk',
    status: 'pending' as const,
    subject: 'Wise CI catch-up',
    to: [], cc: [],
    reply_to: null, thread: null,
    source: 'manual',
    rationale: 'prep for Thursday',
    start: '2026-08-28T14:00:00',
    end: '2026-08-28T14:30:00',
    attendees: ['amh@safetyservices.co.uk'],
    online: true,
    preview: 'Agenda: CI pipeline',
    body_chars: 19,
  };
  const MEETING_DETAIL = { ...MEETING, body: 'Agenda: CI pipeline', sendable: false, sendable_reason: 'not approved (status=pending)' };

  it('renders a meeting with its time and offers Book, never Send', async () => {
    vi.spyOn(api.drafts, 'list').mockResolvedValue({ configured: true, drafts: [MEETING], pending: 1 });
    vi.spyOn(api.drafts, 'get').mockResolvedValue(MEETING_DETAIL);
    const user = userEvent.setup();
    render(<DraftsCard />);
    await user.click(await screen.findByText(/Wise CI catch-up/));
    await screen.findByText(/Agenda: CI pipeline/);
    // The action must be honestly named: this puts an event and invites into
    // the world, not an email.
    expect(screen.getByRole('button', { name: 'Book…' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send…' })).not.toBeInTheDocument();
    // And the card says where the invites will go BEFORE the tap.
    expect(screen.getByText(/invites go to amh@safetyservices.co.uk on booking/)).toBeVisible();
  });

  it('a booked meeting reports booking, not sending', async () => {
    vi.spyOn(api.drafts, 'list').mockResolvedValue({ configured: true, drafts: [MEETING], pending: 1 });
    vi.spyOn(api.drafts, 'get').mockResolvedValue(MEETING_DETAIL);
    vi.spyOn(api.drafts, 'approve').mockResolvedValue({ ...MEETING, status: 'sent', booked: true });
    const user = userEvent.setup();
    render(<DraftsCard />);
    await user.click(await screen.findByText(/Wise CI catch-up/));
    await user.click(await screen.findByRole('button', { name: 'Book…' }));
    await user.click(screen.getByRole('button', { name: 'Confirm book' }));
    expect(await screen.findByText('Booked — invites are out.')).toBeVisible();
  });
});
