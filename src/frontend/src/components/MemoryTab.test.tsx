import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { MemoryComposer, MemoryList } from './MemoryTab';

vi.mock('../api', () => ({
  api: {
    memory: {
      list: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const memoryApi = api.memory as unknown as {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const memory = {
  id: 'mem-rail-1',
  project_id: 'project-1',
  category: 'decision',
  title: 'Archive sessions',
  content: 'Full drawer memory body with decision, rationale, and next actions.',
  source: 'nexus:archive',
  created_at: '2026-06-25T09:00:00.000Z',
  updated_at: '2026-06-25T09:30:00.000Z',
};

describe('MemoryTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryApi.list.mockResolvedValue([memory]);
    memoryApi.create.mockResolvedValue({ id: 'new-memory' });
  });

  it('reveals memory details inline when a drawer row is clicked', async () => {
    const user = userEvent.setup();
    render(<MemoryList projectId="project-1" />);

    const row = await screen.findByRole('button', { name: /Archive sessions/ });
    expect(within(row).queryByText('Source: nexus:archive')).not.toBeInTheDocument();

    await user.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByText('Source: nexus:archive')).toBeInTheDocument();
    expect(within(row).getByText('Updated: 2026-06-25')).toBeInTheDocument();
    expect(within(row).getByText('Full drawer memory body with decision, rationale, and next actions.')).toBeInTheDocument();

    await user.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).queryByText('Source: nexus:archive')).not.toBeInTheDocument();
  });

  it('saves a typed memory on Enter and tells the drawer to reload the list', async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    render(<MemoryComposer projectId="project-1" onAdded={onAdded} />);

    const box = screen.getByPlaceholderText(/Add a memory/);
    await user.type(box, 'Remember this{Enter}');

    await waitFor(() => expect(memoryApi.create).toHaveBeenCalledWith('project-1', { content: 'Remember this', category: 'general' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(box).toHaveValue('');
  });
});
