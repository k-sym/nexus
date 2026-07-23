import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalQueue, { shortCwd, summarizeInput } from './ApprovalQueue';
import type { PendingApproval } from '../hooks/useApprovals';

const gate = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  threadId: 'thread-1',
  toolCallId: 'call-1',
  toolName: 'bash',
  category: 'exec',
  input: { command: 'docker compose up -d' },
  cwd: '/Users/me/Projects/nexus',
  requestedAt: 1_000,
  ...over,
});

/**
 * Serve an NDJSON approval stream the component can read, plus a controller for
 * pushing further frames mid-test. Mirrors the real endpoint: one `snapshot`,
 * then `pending`/`resolved` as they happen.
 */
function mockStream(initial: PendingApproval[]) {
  let push!: (line: string) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'snapshot', approvals: initial })}\n`));
      push = (line) => controller.enqueue(encoder.encode(`${line}\n`));
      close = () => { try { controller.close(); } catch { /* already closed */ } };
    },
  });
  const decisions: Array<{ url: string; body: unknown }> = [];

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/approvals/stream')) {
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    decisions.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { push: (line: string) => push(line), close: () => close(), decisions };
}

describe('summarizeInput', () => {
  it('pulls the field that carries the intent', () => {
    expect(summarizeInput({ command: 'rm -rf build' })).toBe('rm -rf build');
    expect(summarizeInput({ file_path: '/x.ts', extra: 1 })).toBe('/x.ts');
    expect(summarizeInput('literal')).toBe('literal');
  });

  it('never throws on an unrecognised or hostile shape', () => {
    expect(summarizeInput({ weird: 1 })).toBe('{"weird":1}');
    expect(summarizeInput(null)).toBe('');
    expect(summarizeInput(undefined)).toBe('');
    // A cyclic input must render as empty, not crash the queue — an
    // unrenderable gate would be an unanswerable one.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarizeInput(cyclic)).toBe('');
  });
});

describe('shortCwd', () => {
  it('reduces a repo path to its last segment', () => {
    expect(shortCwd('/Users/me/Projects/nexus')).toBe('nexus');
    expect(shortCwd('/Users/me/Projects/nexus/')).toBe('nexus');
    expect(shortCwd('')).toBe('');
  });
});

describe('ApprovalQueue', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('renders nothing when no gate is pending', async () => {
    mockStream([]);
    const { container } = render(<ApprovalQueue />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders a pending gate from the opening snapshot', async () => {
    mockStream([gate()]);
    render(<ApprovalQueue />);

    expect(await screen.findByText('bash')).toBeInTheDocument();
    expect(screen.getByText('docker compose up -d')).toBeInTheDocument();
    // Category and project are surfaced so a shell command doesn't look like a read.
    expect(screen.getByText('Runs a command · nexus')).toBeInTheDocument();
  });

  it('posts a decision and drops the gate from the queue', async () => {
    const { decisions } = mockStream([gate()]);
    render(<ApprovalQueue />);
    await screen.findByText('bash');

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0].url).toContain('/api/approvals/call-1/decision');
    expect(decisions[0].body).toEqual({ action: 'allow' });
    await waitFor(() => expect(screen.queryByText('bash')).not.toBeInTheDocument());
  });

  it('drops a gate the other surface resolved, without us deciding', async () => {
    // The glasses answering first must clear the card here — otherwise the user
    // clicks a gate that no longer exists and gets a 404.
    const { push, decisions } = mockStream([gate()]);
    render(<ApprovalQueue />);
    await screen.findByText('bash');

    push(JSON.stringify({ kind: 'resolved', threadId: 'thread-1', toolCallId: 'call-1' }));

    await waitFor(() => expect(screen.queryByText('bash')).not.toBeInTheDocument());
    expect(decisions).toHaveLength(0);
  });

  it('adds a gate pushed after the snapshot, ignoring a duplicate', async () => {
    const { push } = mockStream([]);
    render(<ApprovalQueue />);

    const approval = gate({ toolCallId: 'call-2', toolName: 'edit', category: 'write', input: { file_path: '/x.ts' } });
    push(JSON.stringify({ kind: 'pending', approval }));
    expect(await screen.findByText('edit')).toBeInTheDocument();

    // The stream subscribes before it snapshots, so the same gate can legitimately
    // arrive twice; it must not render twice.
    push(JSON.stringify({ kind: 'pending', approval }));
    await waitFor(() => expect(screen.getAllByText('edit')).toHaveLength(1));
  });

  it('orders the longest-waiting gate first', async () => {
    mockStream([
      gate({ toolCallId: 'newer', toolName: 'edit', requestedAt: 5_000 }),
      gate({ toolCallId: 'older', toolName: 'grep', requestedAt: 1_000 }),
    ]);
    render(<ApprovalQueue />);

    await screen.findByText('grep');
    const cards = screen.getAllByRole('alertdialog');
    // Oldest is closest to timing out, so it sits under the cursor.
    expect(cards[0]).toHaveTextContent('grep');
    expect(cards[1]).toHaveTextContent('edit');
  });

  it('clears the queue when the stream drops rather than showing stale gates', async () => {
    const { close } = mockStream([gate()]);
    render(<ApprovalQueue />);
    await screen.findByText('bash');

    // Disconnected, we can no longer hear about this gate resolving, so keeping
    // it on screen would be a guess. The reconnect's snapshot is the truth.
    close();
    await waitFor(() => expect(screen.queryByText('bash')).not.toBeInTheDocument());
  });
});
