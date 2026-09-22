import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionDrawer, { loadDrawerState, saveDrawerState, type DrawerState } from './SessionDrawer';

vi.mock('./MemoryTab', () => ({
  MemoryList: () => <div>memory list</div>,
  MemoryComposer: () => <div>memory composer</div>,
}));
vi.mock('./ArtifactPreviewTab', () => ({
  default: ({ selectedPath }: { selectedPath: string | null }) => <div>preview of {selectedPath ?? 'nothing'}</div>,
}));
vi.mock('./SubAgentsTab', () => ({
  default: ({ threadId, running }: { threadId: string | null; running: boolean }) => <div>sub-agents of {threadId} {running ? 'live' : 'idle'}</div>,
}));

function drawer(state: DrawerState, onStateChange = vi.fn()) {
  const view = render(
    <SessionDrawer projectId="p1" threadId="t1" running artifactPath="docs/a.md" state={state} onStateChange={onStateChange} onOpenMemoryPage={vi.fn()} />,
  );
  return { ...view, onStateChange };
}

describe('SessionDrawer', () => {
  beforeEach(() => localStorage.clear());

  it('offers three tabs and mounts only the active one', () => {
    const { onStateChange, rerender } = drawer({ open: true, tab: 'memory' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Memory', 'Preview', 'Sub-agents']);
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Memory' })).toHaveTextContent('memory list');
    expect(screen.getByText('memory composer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open/ })).toBeInTheDocument();
    expect(screen.queryByText(/sub-agents of/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Sub-agents' }));
    expect(onStateChange).toHaveBeenCalledWith({ open: true, tab: 'subagents' });

    rerender(<SessionDrawer projectId="p1" threadId="t1" running artifactPath="docs/a.md" state={{ open: true, tab: 'subagents' }} onStateChange={onStateChange} onOpenMemoryPage={vi.fn()} />);
    expect(screen.getByRole('tabpanel', { name: 'Sub-agents' })).toHaveTextContent('sub-agents of t1 live');
    expect(screen.queryByText('memory composer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open/ })).not.toBeInTheDocument();

    rerender(<SessionDrawer projectId="p1" threadId="t1" running artifactPath="docs/a.md" state={{ open: true, tab: 'preview' }} onStateChange={onStateChange} onOpenMemoryPage={vi.fn()} />);
    expect(screen.getByRole('tabpanel', { name: 'Preview' })).toHaveTextContent('preview of docs/a.md');
  });

  it('collapses to a strip named for the active tab', () => {
    const { onStateChange } = drawer({ open: false, tab: 'subagents' });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show sub-agents'));
    expect(onStateChange).toHaveBeenCalledWith({ open: true, tab: 'subagents' });
  });

  it('remembers its state, honouring the old memory-rail preference until it has its own', () => {
    expect(loadDrawerState()).toEqual({ open: true, tab: 'memory' });
    localStorage.setItem('nexus.memoryRail.open', 'false');
    expect(loadDrawerState()).toEqual({ open: false, tab: 'memory' });
    saveDrawerState({ open: true, tab: 'preview' });
    expect(loadDrawerState()).toEqual({ open: true, tab: 'preview' });
    localStorage.setItem('nexus.sessionDrawer', '{"open":true,"tab":"bogus"}');
    expect(loadDrawerState()).toEqual({ open: false, tab: 'memory' });
    localStorage.setItem('nexus.sessionDrawer', 'not json');
    expect(loadDrawerState()).toEqual({ open: true, tab: 'memory' });
  });

  it('can be resized with pointer or keyboard', async () => {
    drawer({ open: true, tab: 'memory' });
    const rail = screen.getByRole('complementary', { name: 'Session drawer' });
    const handle = screen.getByRole('separator', { name: 'Resize memory' });

    fireEvent.pointerDown(handle, { clientX: 900 });
    const move = new Event('pointermove', { bubbles: true });
    Object.defineProperty(move, 'clientX', { value: 700 });
    fireEvent(window, move);
    await waitFor(() => expect(rail).toHaveStyle({ width: '324px' }));

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(rail).toHaveStyle({ width: '348px' });
  });
});
