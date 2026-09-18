import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolActivity, ToolCallTimeline, type ToolCallInfo } from './ToolCallTimeline';
import { apiFetch } from '../api-base';
import ApprovalQueue from './ApprovalQueue';
import { useApprovals } from '../hooks/useApprovals';
vi.mock('../api-base', () => ({ apiFetch: vi.fn() }));
vi.mock('../hooks/useApprovals', () => ({ useApprovals: vi.fn() }));
const child = { childRunId: 'child-1', role: 'scout', model: 'fake/model', tokens: 12, durationMs: 100, status: 'completed', report: 'Found the callers.' };
const call = (details = child): ToolCallInfo => ({ id: 'delegate', name: 'scout', args: {}, status: 'succeeded', details });
afterEach(() => vi.clearAllMocks());

describe('role child blocks', () => {
  it('keeps Scout collapsed, fetches work only on request and caches ordered tools', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ child, transcriptAvailable: true, messages: [
      { id: 'a', tool_calls: [{ id: 'one', name: 'bash', args: { command: 'first-command' }, status: 'succeeded' }] },
      { id: 'b', tool_calls: [{ id: 'two', name: 'bash', args: { command: 'second-command' }, status: 'succeeded' }] },
    ] })));
    render(<ToolActivity toolCalls={[call()]} running={false} />);
    const header = screen.getByRole('button', { name: /scout fake\/model/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(child.report)).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(header);
    expect(screen.getByText(child.report)).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Show work'));
    await screen.findByText('bash $ first-command');
    const texts = screen.getAllByRole('button').map(b => b.textContent);
    expect(texts.findIndex(t => t?.includes('first-command'))).toBeLessThan(texts.findIndex(t => t?.includes('second-command')));
    fireEvent.click(screen.getByText('Hide work')); fireEvent.click(screen.getByText('Show work'));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it('keeps Refuter report visible outside the collapsed outer activity', () => {
    render(<ToolActivity toolCalls={[call({ ...child, role: 'refuter' })]} running={false} />);
    expect(screen.getByText(child.report)).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('retries failed reads and distinguishes unavailable transcripts', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(new Response(JSON.stringify({ child, transcriptAvailable: false, messages: [] })));
    render(<ToolCallTimeline toolCalls={[call({ ...child, role: 'refuter' })]} />);
    fireEvent.click(screen.getByText('Show work'));
    await screen.findByRole('alert'); fireEvent.click(screen.getByText('Retry'));
    await screen.findByText(/Child transcript unavailable/);
  });
  it('places a pending approval inside a collapsed child block and retains failed decisions for retry', async () => {
    const decide = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(undefined);
    vi.mocked(useApprovals).mockReturnValue({ connected: true, decide, approvals: [{ childRunId: 'child-1', parentToolCallId: 'delegate', threadId: 't', toolCallId: 'edit', toolName: 'Builder · edit', category: 'write', cwd: '/repo', input: { path: 'a.ts' }, requestedAt: 1 }] });
    render(<><ToolActivity toolCalls={[call({ ...child, role: 'builder', status: 'running' })]} running /><ApprovalQueue /></>);
    const block = screen.getByRole('region', { name: 'builder child run' });
    const gate = within(block).getByRole('alertdialog');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(within(gate).getByText('Allow'));
    await within(gate).findByText('Offline');
    fireEvent.click(within(gate).getByText('Allow'));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  });
  it('keeps ordinary call rendering unchanged with unrelated details', () => {
    const ordinary: ToolCallInfo = { id: 'one', name: 'bash', args: { command: 'echo hello' }, status: 'succeeded', result: 'hello' };
    const { container, rerender } = render(<ToolCallTimeline toolCalls={[ordinary]} />);
    const before = container.innerHTML;
    rerender(<ToolCallTimeline toolCalls={[{ ...ordinary, details: { other: true } }]} />);
    expect(container.innerHTML).toBe(before);
    expect(container.innerHTML).toMatchSnapshot();
  });
});
