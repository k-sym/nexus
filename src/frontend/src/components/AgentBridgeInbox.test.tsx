import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { AgentBridgeInbox } from './AgentBridgeInbox';

vi.mock('../api', () => ({
  api: {
    agentBridge: {
      status: vi.fn(),
      messages: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      sendReply: vi.fn(),
      retryReply: vi.fn(),
      discardReply: vi.fn(),
    },
  },
}));

const pending = {
  id: 'message-1',
  sender_id: 'claude-reviewer',
  sender_display_name: 'Claude reviewer',
  sender_harness: 'claude-code',
  project_id: 'project-a',
  thread_id: 'thread-a',
  content: 'Please review the auth path.',
  status: 'pending_approval' as const,
  rejection_reason: null,
  received_at: '2026-09-02T10:00:00.000Z',
  completed_at: null,
};

describe('AgentBridgeInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.agentBridge.status).mockResolvedValue({
      enabled: true,
      state: 'connected',
      mode: 'queue_for_approval',
      instanceId: 'nexus-test',
      subject: 'nexus.bridge.v1.inbox.nexus-test',
      url: 'nats://127.0.0.1:4222',
      durable: true,
    });
    vi.mocked(api.agentBridge.messages).mockResolvedValue({ messages: [pending] });
    vi.mocked(api.agentBridge.approve).mockResolvedValue({ ...pending, status: 'running' });
    vi.mocked(api.agentBridge.reject).mockResolvedValue({ ...pending, status: 'rejected' });
  });

  it('shows routing state and requires an explicit action before a queued message runs', async () => {
    const user = userEvent.setup();
    render(<AgentBridgeInbox />);

    expect(await screen.findByText('Please review the auth path.')).toBeInTheDocument();
    expect(screen.getByText(/connected/)).toBeInTheDocument();
    expect(api.agentBridge.approve).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run in target thread' }));
    await waitFor(() => expect(api.agentBridge.approve).toHaveBeenCalledWith('message-1'));
  });
  it('previews the exact completion reply and sends only on explicit confirmation', async () => {
    const user = userEvent.setup();
    const reply = { id: 'reply-1', message_id: pending.id, destination: 'nexus.bridge.v1.results.cmV2aWV3ZXI',
      payload: JSON.stringify({ kind: 'result', content: 'Review complete' }), status: 'pending_approval' as const, error: null, sent_at: null, attempts: 0, next_attempt_at: null, discarded_at: null, discarded_by: null };
    vi.mocked(api.agentBridge.messages).mockResolvedValue({ messages: [{ ...pending, status: 'completed', reply }] });
    vi.mocked(api.agentBridge.sendReply).mockResolvedValue({ ...reply, status: 'queued' });
    render(<AgentBridgeInbox />);
    expect(await screen.findByText(reply.payload)).toBeInTheDocument();
    expect(screen.getByText(`Destination: ${reply.destination}`)).toBeInTheDocument();
    expect(api.agentBridge.sendReply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send reply to Claude reviewer' }));
    await waitFor(() => expect(api.agentBridge.sendReply).toHaveBeenCalledWith(pending.id));
  });

});

it('stops promising automatic retries and offers explicit Retry and Discard for dead letters', async () => {
  const user = userEvent.setup();
  const reply = { id: 'r', message_id: pending.id, destination: 'nexus.bridge.v1.results.test', payload: '{"content":"Ready"}',
    status: 'dead_letter' as const, error: 'Broker unavailable', sent_at: null, attempts: 60, next_attempt_at: null, discarded_at: null, discarded_by: null };
  vi.mocked(api.agentBridge.status).mockResolvedValue({ enabled: true, state: 'error', mode: 'queue_for_approval', instanceId: 'test', subject: 'test', url: '', durable: true });
  vi.mocked(api.agentBridge.messages).mockResolvedValue({ messages: [{ ...pending, status: 'completed', reply }] });
  vi.mocked(api.agentBridge.retryReply).mockRejectedValueOnce(new Error('Still unavailable'));
  vi.mocked(api.agentBridge.discardReply).mockResolvedValue({ ...reply, status: 'discarded' });
  render(<AgentBridgeInbox />);
  expect(await screen.findByText(/Delivery stopped/)).toBeInTheDocument();
  expect(screen.queryByText(/Will retry automatically/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry reply to Claude reviewer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Still unavailable');
  vi.mocked(api.agentBridge.messages).mockResolvedValue({ messages: [{ ...pending, status: 'completed', reply: { ...reply, status: 'discarded', discarded_at: '2026-09-14T10:00:00Z', discarded_by: 'user' } }] });
  await user.click(screen.getByRole('button', { name: 'Discard reply to Claude reviewer' }));
  await waitFor(() => expect(api.agentBridge.discardReply).toHaveBeenCalledWith(pending.id));
  expect(await screen.findByText(/Discarded by user/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Retry reply/ })).not.toBeInTheDocument();
});
