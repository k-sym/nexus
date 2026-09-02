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
});
