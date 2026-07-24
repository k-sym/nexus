import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ToolDecisionsView from './ToolDecisionsView';
import type { ToolDecisionEntry } from '../api';

const { fetchToolDecisions } = vi.hoisted(() => ({ fetchToolDecisions: vi.fn() }));
vi.mock('../api', () => ({ fetchToolDecisions }));

const entry = (over: Partial<ToolDecisionEntry> = {}): ToolDecisionEntry => ({
  id: 1, thread_id: 't', cwd: '/Users/me/Projects/nexus', tool_name: 'docker_service', category: 'services',
  input_summary: 'up -d', decision: 'confirm', source: 'category', rule_tool: null, rule_when: null,
  outcome: 'allowed', answered_by: 'human', created_at: new Date().toISOString(), ...over,
});

describe('ToolDecisionsView', () => {
  beforeEach(() => { fetchToolDecisions.mockReset().mockResolvedValue([]); });
  afterEach(() => vi.restoreAllMocks());

  it('renders each decision with outcome, source, and how it was reached', async () => {
    fetchToolDecisions.mockResolvedValue([
      entry({ id: 1, tool_name: 'docker_service', outcome: 'allowed', answered_by: 'human' }),
      entry({ id: 2, tool_name: 'browser_navigate', input_summary: 'https://x.com/', decision: 'deny', source: 'rule', rule_tool: 'browser_navigate', rule_when: 'remote_host', outcome: 'denied', answered_by: 'policy' }),
    ]);
    render(<ToolDecisionsView />);

    expect(await screen.findByText('docker_service')).toBeInTheDocument();
    expect(screen.getByText('browser_navigate')).toBeInTheDocument();
    // Outcomes are labelled ran / blocked.
    expect(screen.getByText('ran')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    // The rule source is surfaced with its condition.
    expect(screen.getByText(/rule \(browser_navigate · remote_host\)/)).toBeInTheDocument();
    expect(screen.getByText('denied by policy')).toBeInTheDocument();
  });

  it('shows an empty state when nothing has been recorded', async () => {
    render(<ToolDecisionsView />);
    expect(await screen.findByText(/No tool decisions recorded yet/)).toBeInTheDocument();
  });

  it('shows the error alone, not a misleading empty state', async () => {
    fetchToolDecisions.mockRejectedValue(new Error('down'));
    render(<ToolDecisionsView />);
    expect(await screen.findByText(/Could not reach the backend/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/No tool decisions recorded/)).not.toBeInTheDocument());
  });
});
