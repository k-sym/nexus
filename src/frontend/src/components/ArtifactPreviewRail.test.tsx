import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArtifactPreviewRail from './ArtifactPreviewRail';

describe('ArtifactPreviewRail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders Markdown previews as formatted content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        path: 'notes.md', name: 'notes.md', mimeType: 'text/markdown', kind: 'text', size: 20,
        content: '# Heading\n\n- First item',
      }),
    })));

    render(<ArtifactPreviewRail projectId="p1" selectedPath="notes.md" open onOpenChange={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('allows the preview width to be adjusted with pointer or keyboard', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ path: 'notes.txt', name: 'notes.txt', mimeType: 'text/plain', kind: 'text', size: 4, content: 'Text' }),
    })));

    render(<ArtifactPreviewRail projectId="p1" selectedPath="notes.txt" open onOpenChange={() => {}} />);
    await screen.findByText('Text');
    const rail = screen.getByRole('complementary', { name: 'File preview' });
    const handle = screen.getByRole('separator', { name: 'Resize preview' });

    fireEvent.pointerDown(handle, { clientX: 900 });
    const move = new Event('pointermove', { bubbles: true });
    Object.defineProperty(move, 'clientX', { value: 700 });
    fireEvent(window, move);
    await waitFor(() => expect(rail).toHaveStyle({ width: '324px' }));

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(rail).toHaveStyle({ width: '348px' });
  });
});
