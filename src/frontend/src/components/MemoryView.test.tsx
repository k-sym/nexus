import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import MemoryView from './MemoryView';

vi.mock('../api', () => ({
  api: {
    memory: {
      list: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const memoryApi = api.memory as unknown as {
  list: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const recentMemory = {
  id: 'mem-1',
  project_id: 'project-1',
  category: 'decision',
  title: 'Keep archive body',
  content: 'Full memory body with the useful decision.',
  source: 'nexus',
  created_at: '2026-06-25T09:00:00.000Z',
  updated_at: '2026-06-25T09:30:00.000Z',
};

const searchMemory = {
  id: 'mem-2',
  project_id: 'project-1',
  category: 'chat',
  title: 'Archive',
  content: 'Archived session body with action items and rationale.',
  source: 'nexus:archive',
  created_at: '2026-06-24T18:00:00.000Z',
  updated_at: '2026-06-24T18:30:00.000Z',
};

let writeText: ReturnType<typeof vi.fn>;

function stubClipboard() {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('MemoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText = vi.fn().mockResolvedValue(undefined);
    memoryApi.list.mockResolvedValue([recentMemory]);
    memoryApi.search.mockResolvedValue([searchMemory]);
    memoryApi.create.mockResolvedValue({ id: 'mem-new' });
    memoryApi.update.mockResolvedValue(undefined);
    memoryApi.delete.mockResolvedValue(undefined);
    stubClipboard();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders recent memories with visible management actions and copies content', async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(<MemoryView projectId="project-1" />);

    const row = await screen.findByText('Full memory body with the useful decision.');
    const item = row.closest('article');
    expect(item).not.toBeNull();
    expect(within(item!).getByRole('button', { name: 'View memory' })).toBeVisible();
    await user.click(within(item!).getByRole('button', { name: 'Copy memory' }));

    expect(writeText).toHaveBeenCalledWith('Full memory body with the useful decision.');
  });

  it('renders search results as actionable records instead of anonymous strings', async () => {
    const user = userEvent.setup();
    render(<MemoryView projectId="project-1" />);

    await user.type(screen.getByPlaceholderText(/Search memories/), 'archive');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const result = await screen.findByText('Archived session body with action items and rationale.');
    const item = result.closest('article');
    expect(item).not.toBeNull();
    expect(within(item!).getByText('chat')).toBeInTheDocument();
    expect(within(item!).getByRole('button', { name: 'Edit memory' })).toBeVisible();
    expect(within(item!).getByRole('button', { name: 'Delete memory' })).toBeVisible();
  });

  it('opens a detail panel, edits memory body, and confirms before delete', async () => {
    const user = userEvent.setup();
    render(<MemoryView projectId="project-1" />);

    const row = await screen.findByText('Full memory body with the useful decision.');
    await user.click(within(row.closest('article')!).getByRole('button', { name: 'View memory' }));
    expect(screen.getByRole('heading', { name: 'Keep archive body' })).toBeInTheDocument();
    expect(screen.getByText('Source: nexus')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit memory' }));
    const editor = screen.getByLabelText('Memory content');
    await user.clear(editor);
    await user.type(editor, 'Edited memory body.');
    await user.click(screen.getByRole('button', { name: 'Save memory' }));

    expect(memoryApi.update).toHaveBeenCalledWith('mem-1', { content: 'Edited memory body.' });
    await waitFor(() => expect(memoryApi.list).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: 'Delete memory' }));
    expect(window.confirm).toHaveBeenCalledWith('Delete this memory permanently?');
    expect(memoryApi.delete).toHaveBeenCalledWith('mem-1');
  });

  it('uses current shell accent styling instead of legacy purple memory controls', async () => {
    const user = userEvent.setup();
    render(<MemoryView projectId="project-1" />);

    await user.click(await screen.findByRole('button', { name: /Keep archive body/ }));

    const selectedArticle = screen.getAllByText('Full memory body with the useful decision.')[0].closest('article')!;
    expect(selectedArticle).toHaveClass('border-strong');
    expect(selectedArticle).not.toHaveClass('border-indigo-500/60');

    const categoryLabels = screen.getAllByText('decision');
    expect(categoryLabels[0]).toHaveClass('accent-text');
    expect(categoryLabels[0]).not.toHaveClass('text-indigo-400/80');

    expect(screen.getByRole('button', { name: 'Search' })).toHaveClass('accent-button');
    expect(screen.getByRole('button', { name: 'Add Memory' })).toHaveClass('accent-button');

    await user.click(screen.getByRole('button', { name: 'Edit memory' }));
    expect(screen.getByRole('button', { name: 'Save memory' })).toHaveClass('accent-button');
  });
});
