import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArtifactPreviewTab from './ArtifactPreviewTab';

describe('ArtifactPreviewTab', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders Markdown previews as formatted content under the file name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        path: 'docs/notes.md', name: 'notes.md', mimeType: 'text/markdown', kind: 'text', size: 20,
        content: '# Heading\n\n- First item',
      }),
    })));

    render(<ArtifactPreviewTab projectId="p1" selectedPath="docs/notes.md" />);

    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByTitle('docs/notes.md')).toHaveTextContent('notes.md');
  });

  it('explains itself until a path in chat is clicked', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ArtifactPreviewTab projectId="p1" selectedPath={null} />);
    expect(screen.getByText('Click a file path in the chat to preview it here.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
