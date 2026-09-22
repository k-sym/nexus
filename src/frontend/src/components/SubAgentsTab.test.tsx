import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { apiFetch } from '../api-base';
import SubAgentsTab, { splitReport } from './SubAgentsTab';

vi.mock('../api', () => ({ api: { roles: { runs: vi.fn() } } }));
vi.mock('../api-base', () => ({ apiFetch: vi.fn() }));
const rolesApi = api.roles as unknown as { runs: ReturnType<typeof vi.fn> };

const done = {
  childRunId: 'child-1', role: 'scout', model: 'fake/model', status: 'completed', tokens: 1200, durationMs: 4500,
  report: 'Found the callers.', parentRunId: 'run-1', parentToolCallId: 'call-1',
  startedAt: '2026-09-22T08:00:00.000Z', completedAt: '2026-09-22T08:00:04.500Z',
};
const stopped = { ...done, childRunId: 'child-2', role: 'builder', status: 'incomplete', parentToolCallId: 'call-2',
  report: 'INCOMPLETE: Turn ceiling reached\n\nPartial edit made.', startedAt: '2026-09-22T09:00:00.000Z' };
const live = { ...done, childRunId: 'child-3', role: 'refuter', status: 'running', tokens: 0, durationMs: 0, report: '',
  completedAt: null, parentToolCallId: 'call-3', startedAt: new Date(Date.now() - 12_000).toISOString() };

afterEach(() => vi.clearAllMocks());

describe('SubAgentsTab', () => {
  it('lists the session\'s sub-agents newest first and expands one into ids, reason, report and work', async () => {
    rolesApi.runs.mockResolvedValue({ runs: [stopped, done] });
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ child: stopped, transcriptAvailable: true, messages: [
      { id: 'a', tool_calls: [{ id: 'one', name: 'bash', args: { command: 'npm test' }, status: 'succeeded' }] },
    ] })));
    render(<SubAgentsTab threadId="t1" running={false} />);

    expect(await screen.findByText('2 runs')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { expanded: false });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Builder');
    expect(rows[0]).toHaveTextContent('incomplete');
    expect(rows[1]).toHaveTextContent('Scout');
    expect(rows[1]).toHaveTextContent('1,200 tokens · 4.5s · 2026-09-22 08:00:00');
    expect(apiFetch).not.toHaveBeenCalled();

    fireEvent.click(rows[0]);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Stopped early: Turn ceiling reached')).toBeInTheDocument();
    expect(screen.getByText('Partial edit made.')).toBeInTheDocument();
    expect(screen.getByText('child-2')).toBeInTheDocument();
    expect(screen.getByText('run-1')).toBeInTheDocument();
    expect(screen.getByText('call-2')).toBeInTheDocument();
    await screen.findByText('bash $ npm test');
    expect(apiFetch).toHaveBeenCalledWith('/api/runs/child-2/events', expect.anything());
  });

  it('shows a running child with its elapsed time and no token count yet', async () => {
    rolesApi.runs.mockResolvedValue({ runs: [live] });
    render(<SubAgentsTab threadId="t1" running />);

    expect(await screen.findByText('1 run · 1 running')).toBeInTheDocument();
    const row = screen.getByRole('button', { expanded: false });
    expect(row).toHaveTextContent('Refuter');
    expect(row).toHaveTextContent('running');
    expect(row).toHaveTextContent('… tokens');
    expect(row).toHaveTextContent(/1[0-9]\.[0-9]s/);
  });

  it('explains an empty session and the absence of one', async () => {
    rolesApi.runs.mockResolvedValue({ runs: [] });
    const { rerender } = render(<SubAgentsTab threadId={null} running={false} />);
    expect(screen.getByText('Open a session to see its sub-agents.')).toBeInTheDocument();
    expect(rolesApi.runs).not.toHaveBeenCalled();

    rerender(<SubAgentsTab threadId="t1" running={false} />);
    expect(await screen.findByText('No sub-agents have run in this session yet.')).toBeInTheDocument();
    expect(rolesApi.runs).toHaveBeenCalledWith('t1');
  });

  it('splits the runner\'s early-stop prefix from the report body', () => {
    expect(splitReport('INCOMPLETE: Time ceiling reached\n\nNo report returned.')).toEqual({ reason: 'Time ceiling reached', body: 'No report returned.' });
    expect(splitReport('Ordinary report.')).toEqual({ reason: null, body: 'Ordinary report.' });
    expect(splitReport(undefined)).toEqual({ reason: null, body: '' });
  });
});
