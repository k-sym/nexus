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
